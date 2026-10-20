/** Native Node stream brand and current-policy contract; no provider or database. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeActionCapabilities } from "./capability-authorization.ts";
import type { ActionContext } from "./types.ts";

for (
  const mode of [
    "reader",
    "tee",
    "pipeThrough",
    "iterator",
    "pipeTo",
    "responseText",
    "responseBytes",
  ] as const
) {
  test(`native stream policy remains current for ${mode}`, async () => {
    let allowed = true, reads = 0;
    const ctx = authorizeActionCapabilities(
      {
        content: {
          open: () =>
            new ReadableStream<Uint8Array>({
              pull(c) {
                reads++;
                c.enqueue(new Uint8Array([65 + reads]));
                if (reads === 3) c.close();
              },
            }, { highWaterMark: 0 }),
        },
      } as unknown as ActionContext,
      () => {},
      () => {},
      undefined,
      () => allowed ? Promise.resolve() : Promise.reject(new Error("denied")),
    );
    const stream = await ctx.content.open({} as never);
    assert.equal(stream instanceof ReadableStream, true);
    if (mode === "responseText" || mode === "responseBytes") {
      allowed = false;
      const response = new Response(stream);
      await assert.rejects(
        () =>
          mode === "responseText" ? response.text() : response.arrayBuffer(),
        /denied/,
      );
      assert.equal(reads, 0);
    } else if (mode === "pipeTo") {
      const writes: unknown[] = [];
      await assert.rejects(
        () =>
          stream.pipeTo(
            new WritableStream({
              write(value) {
                writes.push(value);
                allowed = false;
              },
            }),
          ),
        /denied/,
      );
      assert.equal(writes.length, 1);
    } else if (mode === "iterator") {
      const iterator = stream[Symbol.asyncIterator]();
      assert.deepEqual((await iterator.next()).value, new Uint8Array([66]));
      allowed = false;
      await assert.rejects(() => iterator.next(), /denied/);
    } else {
      const branches = mode === "tee" ? stream.tee() : [stream];
      const source = mode === "pipeThrough"
        ? stream.pipeThrough(new TransformStream())
        : branches[0];
      const reader = source.getReader();
      assert.deepEqual((await reader.read()).value, new Uint8Array([66]));
      const retained = mode === "tee" ? branches[1].getReader() : reader;
      allowed = false;
      await assert.rejects(() => retained.read(), /denied/);
    }
  });
}
test("authorized native streams support Node Response and iteration", async () => {
  const ctx = authorizeActionCapabilities(
    {
      content: {
        open: () =>
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode("safe"));
              c.close();
            },
          }),
      },
    } as unknown as ActionContext,
    () => {},
    () => {},
    undefined,
    () => Promise.resolve(),
  );
  assert.equal(
    await new Response(await ctx.content.open({} as never)).text(),
    "safe",
  );
  assert.equal(
    new TextDecoder().decode(
      await new Response(await ctx.content.open({} as never)).arrayBuffer(),
    ),
    "safe",
  );
  const chunks: Uint8Array[] = [];
  for await (const chunk of await ctx.content.open({} as never)) {
    chunks.push(chunk);
  }
  assert.equal(new TextDecoder().decode(chunks[0]), "safe");
});

test("authorized byte streams preserve synchronous BYOB reader selection", async () => {
  let allowed = true;
  const ctx = authorizeActionCapabilities(
    {
      content: {
        open: () =>
          new ReadableStream({
            type: "bytes",
            start(c) {
              c.enqueue(new Uint8Array([1, 2]));
              c.close();
            },
          }),
      },
    } as unknown as ActionContext,
    () => {},
    () => {},
    undefined,
    () => allowed ? Promise.resolve() : Promise.reject(new Error("denied")),
  );
  const stream = await ctx.content.open({} as never);
  const reader = stream.getReader({ mode: "byob" });
  assert.equal(reader instanceof Promise, false);
  assert.deepEqual(
    (await reader.read(new Uint8Array(1))).value,
    new Uint8Array([1]),
  );
  allowed = false;
  await assert.rejects(() => reader.read(new Uint8Array(1)), /denied/);
});
