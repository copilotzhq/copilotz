/**
 * The GCS blob store against a fake of GCS's JSON API and the metadata
 * server, through an injected `fetch`: no network.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createRuntime, defineAction, defineCollection, definePlugin } from "../../runtime/mod.ts";
import { gcsBlobs } from "../blobs/gcs/mod.ts";
import { memoryStore } from "../memory/mod.ts";
import { blobId } from "../../runtime/blobs.ts";
import { test } from "../../testing/mod.ts";

type Call = { method: string; url: URL; headers: Headers; signal?: AbortSignal | null };

/**
 * GCS and the metadata server in memory. `fail` answers a request first,
 * when it returns a Response (or throws); `expiresIn` is each token's life.
 */
function fake(
  options: { expiresIn?: number; fail?: (call: Call) => Response | undefined | Promise<never> } =
    {},
) {
  const objects = new Map<string, { data: Uint8Array; type: string }>();
  const calls: Call[] = [];
  let tokens = 0;
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const call = {
      method: init.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init.headers),
      signal: init.signal,
    };
    calls.push(call);
    const failing = options.fail?.(call);
    if (failing) return await failing;
    const { url } = call;
    if (url.hostname === "metadata.google.internal") {
      assertEquals(call.headers.get("metadata-flavor"), "Google");
      tokens++;
      return Response.json({
        access_token: `token-${tokens}`,
        expires_in: options.expiresIn ?? 3599,
        token_type: "Bearer",
      });
    }
    assertEquals(url.origin, "https://storage.googleapis.com");
    if (!call.headers.get("authorization")?.startsWith("Bearer token-")) {
      return new Response("no", { status: 401 });
    }
    const upload = /^\/upload\/storage\/v1\/b\/([^/]+)\/o$/.exec(url.pathname);
    if (upload && call.method === "POST") {
      assertEquals(url.searchParams.get("uploadType"), "media");
      assertEquals(url.searchParams.get("ifGenerationMatch"), "0");
      const key = `${upload[1]}/${url.searchParams.get("name")}`;
      if (objects.has(key)) return Response.json({ error: { code: 412 } }, { status: 412 });
      objects.set(key, {
        data: new Uint8Array(await new Response(init.body).arrayBuffer()),
        type: call.headers.get("content-type")!,
      });
      return Response.json({ name: url.searchParams.get("name"), generation: "1" });
    }
    const object = /^\/storage\/v1\/b\/([^/]+)\/o\/([^/]+)$/.exec(url.pathname);
    if (object && call.method === "GET") {
      assertEquals(url.searchParams.get("alt"), "media");
      const found = objects.get(`${object[1]}/${decodeURIComponent(object[2])}`);
      if (!found) return Response.json({ error: { code: 404 } }, { status: 404 });
      return new Response(found.data as BodyInit, { headers: { "content-type": found.type } });
    }
    return new Response("unexpected", { status: 400 });
  };
  const to = (host: string) => calls.filter((c) => c.url.hostname === host);
  return {
    objects,
    calls,
    fetch,
    gcs: () => to("storage.googleapis.com"),
    metadata: () => to("metadata.google.internal"),
  };
}

const text = new TextEncoder().encode("x".repeat(20_000));
const blob = async () => ({
  id: await blobId(text),
  data: text,
  type: "text/plain; charset=utf-8",
});

test("gcs blobs: a blob put is the object <prefix>/<id>, read back with its type", async () => {
  const gcs = fake();
  const blobs = gcsBlobs({ bucket: "media", prefix: "/org_1/blobs/", fetch: gcs.fetch });
  const one = await blob();
  await blobs.put(one);
  assertEquals([...gcs.objects.keys()], [`media/org_1/blobs/${one.id}`]);
  assertEquals(gcs.objects.get(`media/org_1/blobs/${one.id}`)!.type, one.type);
  const got = await blobs.get(one.id);
  assertEquals(got, { data: text, type: one.type });
  // The object's name is one path segment of the URL.
  assert(gcs.gcs()[1].url.pathname.endsWith(`/o/org_1%2Fblobs%2F${one.id}`));
  assertEquals(gcs.gcs().map((c) => c.headers.get("authorization")), [
    "Bearer token-1",
    "Bearer token-1",
  ]);
});

test("gcs blobs: without a prefix, objects are at the bucket's top", async () => {
  const gcs = fake();
  const blobs = gcsBlobs({ bucket: "media", fetch: gcs.fetch });
  const one = await blob();
  await blobs.put({ id: one.id, data: one.data });
  assertEquals(gcs.objects.get(`media/${one.id}`)?.type, "application/octet-stream");
});

test("gcs blobs: putting what's there (412) is a success, and changes nothing", async () => {
  const gcs = fake();
  const blobs = gcsBlobs({ bucket: "media", fetch: gcs.fetch });
  const one = await blob();
  await blobs.put(one);
  await blobs.put({ ...one, data: new Uint8Array([1]) });
  assertEquals(gcs.gcs().length, 2);
  assertEquals((await blobs.get(one.id))?.data, text);
});

test("gcs blobs: a blob that isn't there is null; other answers fail with their status", async () => {
  const gcs = fake({
    fail: (c) =>
      c.url.pathname.includes("forbidden") ? new Response("denied", { status: 403 }) : undefined,
  });
  const blobs = gcsBlobs({ bucket: "media", fetch: gcs.fetch });
  assertEquals(await blobs.get("sha256-none"), null);
  const error = await assertRejects(() => blobs.get("forbidden"), Error, "HTTP 403 denied");
  assertEquals((error as Error & { status: number }).status, 403);
  // 4xx isn't tried again.
  assertEquals(gcs.gcs().length, 2);
});

test("gcs blobs: the metadata server's token is kept, and asked for once at a time", async () => {
  const gcs = fake();
  const blobs = gcsBlobs({ bucket: "media", fetch: gcs.fetch });
  const one = await blob();
  await Promise.all([blobs.put(one), blobs.get(one.id), blobs.get("sha256-other")]);
  await blobs.get(one.id);
  assertEquals(gcs.metadata().length, 1);
  assertEquals(gcs.gcs().length, 4);
});

test("gcs blobs: a token within a minute of expiring is renewed", async () => {
  const gcs = fake({ expiresIn: 30 });
  const blobs = gcsBlobs({ bucket: "media", fetch: gcs.fetch });
  await blobs.get("sha256-a");
  await blobs.get("sha256-b");
  assertEquals(gcs.metadata().length, 2);
  assertEquals(gcs.gcs().map((c) => c.headers.get("authorization")), [
    "Bearer token-1",
    "Bearer token-2",
  ]);
});

test("gcs blobs: token() replaces the metadata server", async () => {
  const gcs = fake();
  let asked = 0;
  const blobs = gcsBlobs({
    bucket: "media",
    fetch: gcs.fetch,
    token: () => `token-own-${++asked}`,
  });
  await blobs.get("sha256-a");
  await blobs.get("sha256-b");
  assertEquals(gcs.metadata().length, 0);
  assertEquals(gcs.gcs().map((c) => c.headers.get("authorization")), [
    "Bearer token-own-1",
    "Bearer token-own-2",
  ]);
});

test("gcs blobs: 429, 5xx and the network are tried again, up to three times", async () => {
  // Two failures, then through.
  let broken = 0;
  const flaky = fake({
    fail: (c) => {
      if (c.url.hostname !== "storage.googleapis.com" || broken >= 2) return undefined;
      return broken++ === 0
        ? new Response("busy", { status: 429 })
        : Promise.reject(new TypeError("connection reset"));
    },
  });
  const one = await blob();
  await gcsBlobs({ bucket: "media", fetch: flaky.fetch }).put(one);
  assertEquals(flaky.gcs().length, 3);
  assertEquals(flaky.objects.size, 1);

  // Failing every time: three tries, then the last failure.
  const down = fake({
    fail: (c) =>
      c.url.hostname === "storage.googleapis.com" ? new Response("", { status: 503 }) : undefined,
  });
  const error = await assertRejects(
    () => gcsBlobs({ bucket: "media", fetch: down.fetch }).get(one.id),
    Error,
    "HTTP 503",
  );
  assertEquals((error as Error & { status: number }).status, 503);
  assertEquals(down.gcs().length, 3);
});

test("gcs blobs: a try that takes too long is given up, and tried again", async () => {
  let slow = 1;
  const gcs = fake({
    fail: ({ url, signal }) => {
      if (url.hostname !== "storage.googleapis.com" || slow-- <= 0) return undefined;
      // Answers only when aborted, as fetch does.
      return new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const blobs = gcsBlobs({ bucket: "media", fetch: gcs.fetch, timeout: 50 });
  const started = Date.now();
  assertEquals(await blobs.get("sha256-a"), null);
  assert(Date.now() - started >= 50);
  assertEquals(gcs.gcs().length, 2);
});

test("gcs blobs: a runtime keeps large values in the bucket, and reads them back whole", async () => {
  const gcs = fake();
  const store = memoryStore();
  const notes = definePlugin({
    name: "notes",
    collections: {
      note: defineCollection({ schema: { type: "object" }, queries: { all: (n) => n.find({}) } }),
    },
    actions: {
      "note.add": defineAction({
        input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        run: async (ctx, input) =>
          (await ctx.db.collection("note").insertOne({ text: input.text })).insertedId,
      }),
    },
  });
  const runtime = await createRuntime({
    store,
    plugins: [notes],
    blobs: gcsBlobs({ bucket: "media", prefix: "blobs", fetch: gcs.fetch }),
  });
  try {
    const big = "x".repeat(20_000);
    await runtime.call("note.add", { text: big });
    const ref = (await store.find("note"))[0].text as { $blob: string };
    assertEquals(gcs.objects.get(`media/blobs/${ref.$blob}`)?.data.length, 20_000);
    assertEquals(await store.blob(ref.$blob), null);
    const docs = await runtime.query<{ text: string }[]>("note.all");
    assertEquals(docs[0].text, big);
  } finally {
    await runtime.close();
  }
});
