import { Buffer } from "node:buffer";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createPhysicalS3Requester } from "./physical-s3-request.ts";
import { digestContent } from "./digest.ts";
import { OWNER_PHYSICAL_OBJECT_ROOT } from "./physical-object-namespace.ts";

const config = {
  backendId: "physical-test",
  endpoint: "https://objects.example.test/prefix+plus",
  region: "us-east-1",
  bucket: "test-bucket",
  accessKeyId: "test-access",
  secretAccessKey: "test-secret",
  sessionToken: "test-session",
};
const objectName = `${OWNER_PHYSICAL_OBJECT_ROOT}abcdef/manifest.json`;
const bytes = (text: string) => new TextEncoder().encode(text);
const request = { method: "GET" as const, objectName, maxResponseBytes: 100 };
Deno.test("physical S3 signs exact conditions, owned payload, token and request options", async () => {
  const bodies: Uint8Array[] = [],
    conditions: string[] = [],
    signatures: string[] = [];
  const send: typeof fetch = async (input) => {
    assert(input instanceof Request);
    assertEquals(input.redirect, "error");
    assertEquals(
      input.url,
      `https://objects.example.test/prefix%2Bplus/test-bucket/${objectName}`,
    );
    assertEquals(input.headers.get("x-amz-security-token"), "test-session");
    const payload = new Uint8Array(await input.arrayBuffer());
    bodies.push(payload);
    assertEquals(
      input.headers.get("x-amz-content-sha256"),
      (await digestContent(payload)).slice(7),
    );
    const auth = input.headers.get("authorization")!;
    assert(auth.includes("if-match"));
    assert(auth.includes("x-amz-content-sha256"));
    conditions.push(input.headers.get("if-match")!);
    signatures.push(auth);
    return new Response(null, { status: 200 });
  };
  const run = createPhysicalS3Requester(config, { fetch: send });
  const supplied = bytes("owned");
  const pending = run({
    ...request,
    method: "PUT",
    body: supplied,
    headers: { "if-match": '"one"' },
  });
  supplied.fill(0);
  await pending;
  await run({
    ...request,
    method: "PUT",
    body: bytes("owned"),
    headers: { "if-match": '"two"' },
  });
  assertEquals(bodies, [bytes("owned"), bytes("owned")]);
  assertEquals(conditions, ['"one"', '"two"']);
  assert(signatures[0] !== signatures[1]);
});
Deno.test("physical S3 supports bucket host style and signs create-only conditions", async () => {
  const run = createPhysicalS3Requester({ ...config, pathStyle: false }, {
    fetch: (input) => {
      assert(input instanceof Request);
      assertEquals(
        new URL(input.url).hostname,
        "test-bucket.objects.example.test",
      );
      assert(!new URL(input.url).pathname.includes("test-bucket"));
      assert(input.headers.get("authorization")!.includes("if-none-match"));
      return Promise.resolve(new Response(null));
    },
  });
  await run({
    ...request,
    method: "PUT",
    body: bytes("{}"),
    headers: { "if-none-match": "*" },
  });
});
Deno.test("physical S3 bounds declared and streamed success/error bodies and joins cancellation", async () => {
  for (const status of [200, 500]) {
    let release!: () => void, cancelled!: () => void;
    const cancelStarted = new Promise<void>((resolve) => cancelled = resolve);
    const held = new Promise<void>((resolve) => release = resolve);
    const run = createPhysicalS3Requester(config, {
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new Uint8Array(status === 500 ? 65537 : 101),
                );
              },
              cancel() {
                cancelled();
                return held;
              },
            }),
            { status },
          ),
        ),
    });
    let settled = false;
    const failure = assertRejects(() => run(request)).then(() => {
      settled = true;
    });
    await cancelStarted;
    await Promise.resolve();
    assertEquals(settled, false);
    release();
    await failure;
    assertEquals(settled, true);
  }
  let cancelled = false;
  const run = createPhysicalS3Requester(config, {
    fetch: () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-length": "101" } },
        ),
      ),
  });
  await assertRejects(() => run(request));
  assertEquals(cancelled, true);
});
Deno.test("physical S3 deadline covers response body without hidden retries", async () => {
  let calls = 0;
  const run = createPhysicalS3Requester(config, {
    timeoutMs: 20,
    fetch: (input) => {
      assert(input instanceof Request);
      calls++;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              input.signal.addEventListener(
                "abort",
                () => controller.error(new Error("aborted")),
                { once: true },
              );
            },
          }),
        ),
      );
    },
  });
  const error = await assertRejects(() =>
    run({
      ...request,
      method: "PUT",
      headers: { "if-none-match": "*" },
      body: bytes("maybe committed"),
    })
  );
  assertEquals((error as { code: string }).code, "asset_storage_unavailable");
  assertEquals(calls, 1);
});
Deno.test("physical S3 refuses provider mismatch, unsafe paths and preexisting authentication", async () => {
  assertThrows(() => createPhysicalS3Requester({ ...config, provider: "gcs" }));
  assertThrows(() =>
    createPhysicalS3Requester({
      ...config,
      endpoint: "http://objects.example.test",
    })
  );
  let calls = 0;
  const run = createPhysicalS3Requester(config, {
    fetch: () => {
      calls++;
      return Promise.resolve(new Response(null));
    },
  });
  for (
    const name of [
      "legacy",
      `${OWNER_PHYSICAL_OBJECT_ROOT}../legacy`,
      `${OWNER_PHYSICAL_OBJECT_ROOT}a//b`,
    ]
  ) {
    await assertRejects(() => run({ ...request, objectName: name }));
  }
  await assertRejects(() =>
    run({ ...request, headers: { authorization: "old" } })
  );
  assertEquals(calls, 0);
});
Deno.test("physical S3 HEAD allows object length and preserves non-success status without parsing", async () => {
  const run = createPhysicalS3Requester(config, {
    fetch: (input) => {
      assert(input instanceof Request);
      return Promise.resolve(
        input.method === "HEAD"
          ? new Response(null, {
            headers: { "content-length": "99999999", etag: '"version"' },
          })
          : new Response("not XML", { status: 412 }),
      );
    },
  });
  const head = await run({ ...request, method: "HEAD", maxResponseBytes: 0 });
  assertEquals(head.bytes.length, 0);
  assertEquals(head.headers.get("etag"), '"version"');
  const conflict = await run(request);
  assertEquals(conflict.status, 412);
  assertEquals(conflict.bytes, bytes("not XML"));
});

Deno.test("physical S3 owns Buffer subview bytes and hashes only that captured view", async () => {
  const seen: Uint8Array[] = [];
  const run = createPhysicalS3Requester(config, {
    fetch: async (input) => {
      assert(input instanceof Request);
      const actual = new Uint8Array(await input.arrayBuffer());
      seen.push(actual);
      assertEquals(
        input.headers.get("x-amz-content-sha256"),
        (await digestContent(actual)).slice(7),
      );
      return new Response(null);
    },
  });
  const original = Buffer.from("prefix:payload:suffix");
  const view = original.subarray(7, 14);
  const pending = run({
    ...request,
    method: "PUT",
    headers: { "if-none-match": "*" },
    body: view,
  });
  original.fill(0);
  await pending;
  await run({
    ...request,
    method: "PUT",
    body: Buffer.from("xxpayloadyy").subarray(2, 9),
    headers: { "if-none-match": "*" },
  });
  assertEquals(seen, [bytes("payload"), bytes("payload")]);
});

Deno.test("physical S3 owns each response Buffer before requesting the next chunk", async () => {
  const first = Buffer.from([1, 2]);
  let pulls = 0;
  const run = createPhysicalS3Requester(config, {
    fetch: () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            pull(controller) {
              if (pulls++ === 0) controller.enqueue(first);
              else {
                first.fill(0);
                controller.enqueue(Buffer.from([3, 4]));
                controller.close();
              }
            },
          }, { highWaterMark: 0 }),
        ),
      ),
  });
  assertEquals((await run(request)).bytes, new Uint8Array([1, 2, 3, 4]));
});
Deno.test("physical S3 refuses unconditional, ambiguous or weak PUT guards before dispatch", async () => {
  let calls = 0;
  const run = createPhysicalS3Requester(config, {
    fetch: () => {
      calls++;
      return Promise.resolve(new Response(null));
    },
  });
  for (
    const headers of [
      new Headers(),
      new Headers({ "if-match": "*" }),
      new Headers({ "if-match": 'W/"weak"' }),
      new Headers({ "if-match": '"a", "b"' }),
      new Headers({ "if-none-match": '"one"' }),
      new Headers({ "if-match": '"one"', "if-none-match": "*" }),
    ]
  ) {
    const error = await assertRejects(() =>
      run({ ...request, method: "PUT", body: bytes("x"), headers })
    );
    assertEquals((error as { code: string }).code, "content_invalid");
  }
  assertEquals(calls, 0);
});
