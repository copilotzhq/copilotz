import { assertEquals, assertRejects } from "@std/assert";
import { createCopilotzClient } from "./index.ts";
import { decodeObservation, ProtocolError } from "./protocol.ts";

const enc = new TextEncoder();
function wire(
  frames: readonly {
    kind: string;
    content: string | Uint8Array;
    headers?: string;
  }[],
  close = true,
) {
  const parts = frames.flatMap((frame, index) => {
    const content = typeof frame.content === "string"
      ? enc.encode(frame.content)
      : frame.content;
    return [
      enc.encode(
        `--test\r\nx-copilotz-frame: ${frame.kind}\r\nx-copilotz-cursor: checkpoint-${index}\r\ncontent-length: ${content.length}\r\n${
          frame.headers ?? ""
        }\r\n`,
      ),
      content,
      enc.encode("\r\n"),
    ];
  });
  if (close) parts.push(enc.encode("--test--\r\n"));
  return new Response(
    new ReadableStream({
      start(controller) {
        // Every UTF-8 codepoint, CRLF and length header crosses network reads.
        for (const part of parts) {
          for (const byte of part) controller.enqueue(new Uint8Array([byte]));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "multipart/mixed; boundary=test" } },
  );
}

Deno.test("multipart preserves binary boundary bytes and split UTF-8 JSON", async () => {
  const bytes = new Uint8Array([0, 255, ...enc.encode("\r\n--test\r\n😀")]);
  const response = wire([
    {
      kind: "output",
      content: JSON.stringify({
        type: "stream.output",
        streamId: "s",
        name: "🌎",
      }),
    },
    {
      kind: "stream-chunk",
      content: bytes,
      headers: "x-copilotz-stream-id: s\r\nx-copilotz-offset: 7\r\n",
    },
    {
      kind: "stream-end",
      content: JSON.stringify({
        offset: 7 + bytes.length,
        outcome: "completed",
        capture: "complete",
        availability: "retained",
        terminalAt: "2026-09-04T00:00:00Z",
      }),
      headers: `x-copilotz-stream-id: s\r\nx-copilotz-offset: ${
        7 + bytes.length
      }\r\n`,
    },
  ]);
  const frames = await Array.fromAsync(decodeObservation(response));
  assertEquals(frames[1].kind === "stream-chunk" && frames[1].bytes, bytes);
});

Deno.test("truncation and orphaned streams fail explicitly", async () => {
  await assertRejects(
    () =>
      Array.fromAsync(decodeObservation(wire([
        { kind: "output", content: '{"type":"event"}' },
      ], false))),
    ProtocolError,
    "truncated",
  );
  await assertRejects(
    () =>
      Array.fromAsync(decodeObservation(wire([
        {
          kind: "stream-chunk",
          content: new Uint8Array([1]),
          headers: "x-copilotz-stream-id: missing\r\nx-copilotz-offset: 0\r\n",
        },
      ]))),
    ProtocolError,
    "lane",
  );
});

Deno.test("onFrame is awaited and callback failure detaches without retry", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const applied: string[] = [];
  const client = createCopilotzClient({
    baseUrl: "/api",
    fetch: (() => {
      calls++;
      return Promise.resolve(wire([
        { kind: "output", content: '{"type":"first"}' },
        { kind: "output", content: '{"type":"second"}' },
      ]));
    }) as typeof fetch,
  });
  const observation = client.operations.observe({
    operationIds: ["a"],
    async onFrame(frame) {
      applied.push(frame.checkpoint);
      await gate;
      throw new Error("projection failed");
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(applied, ["checkpoint-0"]);
  release();
  await assertRejects(() => observation, Error, "projection failed");
  assertEquals(calls, 1);
});

Deno.test("lost receipt retry retains exact input and idempotency key", async () => {
  const submissions: string[] = [];
  const input = { value: 1 };
  const client = createCopilotzClient({
    baseUrl: "https://test/api",
    // deno-lint-ignore require-await -- model a rejected Fetch promise
    fetch: (async (_url, init) => {
      submissions.push(
        `${new Headers(init?.headers).get("idempotency-key")}:${init?.body}`,
      );
      if (submissions.length === 1) {
        input.value = 2;
        throw new TypeError("connection lost");
      }
      return Response.json({ data: { operationId: "op" } }, { status: 202 });
    }) as typeof fetch,
  });
  const receipt = await client.actions.submit("test.echo", input, {
    idempotencyKey: "stable",
  });
  assertEquals(receipt.operationId, "op");
  assertEquals(submissions, ['stable:{"value":1}', 'stable:{"value":1}']);
});

Deno.test("read retries are bounded and header-provider failures are never transport retries", async () => {
  let calls = 0;
  const client = createCopilotzClient({
    baseUrl: "https://test/api",
    fetch: (() => {
      calls++;
      if (calls === 1) throw new TypeError("connection reset");
      if (calls === 2) {
        return Promise.resolve(
          Response.json({ error: { code: "persistence_unavailable" } }, {
            status: 503,
          }),
        );
      }
      return Promise.resolve(Response.json({ data: [] }));
    }) as typeof fetch,
  });
  assertEquals(await client.http.json("/threads"), { data: [] });
  assertEquals(calls, 3);
  let headers = 0;
  const broken = createCopilotzClient({
    baseUrl: "https://test/api",
    getRequestHeaders: () => {
      headers++;
      throw new TypeError("header configuration");
    },
  });
  await assertRejects(
    () => broken.actions.submit("example", {}, { idempotencyKey: "key" }),
    TypeError,
    "header configuration",
  );
  assertEquals(headers, 1);
});

Deno.test("aborted reads perform no transport work", async () => {
  let calls = 0;
  const client = createCopilotzClient({
    baseUrl: "https://test/api",
    fetch: (() => {
      calls++;
      return Promise.resolve(new Response());
    }) as typeof fetch,
  });
  const abort = new AbortController();
  abort.abort(new Error("navigation"));
  await assertRejects(
    () => client.http.json("/threads", { signal: abort.signal }),
    Error,
    "navigation",
  );
  assertEquals(calls, 0);
});

Deno.test("a disconnected multipart response resumes only after the successfully applied frame", async () => {
  const checkpoints: unknown[] = [];
  let calls = 0;
  const applied: string[] = [];
  const client = createCopilotzClient({
    baseUrl: "https://test/api",
    fetch: ((_url, init) => {
      checkpoints.push(JSON.parse(String(init?.body)).checkpoint);
      calls++;
      return Promise.resolve(
        wire([{
          kind: "output",
          content: JSON.stringify({ type: calls === 1 ? "first" : "second" }),
        }], calls > 1),
      );
    }) as typeof fetch,
  });
  await client.operations.observe({
    operationIds: ["operation"],
    checkpoint: "initial",
    async onFrame(frame) {
      await Promise.resolve();
      if (frame.kind === "output") applied.push(frame.output.type);
    },
  });
  assertEquals(checkpoints, ["initial", "checkpoint-0"]);
  assertEquals(applied, ["first", "second"]);
});
