/**
 * An operation's Action, against a fetch the test answers (no network):
 * the settings' base URL and headers (static, or a hook), what comes back
 * (JSON, text, a file, nothing), and what fails: an API's error with its
 * status, a call too slow or stopped, a response too large, settings that
 * can't work.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createRuntime, defineAction, definePlugin, type Plugin } from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import models from "../../../models/mod.ts";
import { chat } from "../../chat/mod.ts";
import { openapi, type OpenApiSettings } from "../mod.ts";
import { test } from "../../../../testing/mod.ts";
import { fake, json, type Seen } from "./fake.ts";
import spec from "./trips.json" with { type: "json" };

/** Calls the trips API's Action and reports how it failed, from inside: the error as it is. */
const probe = defineAction({
  input: { type: "object" },
  run: async (ctx, input) => {
    try {
      return { result: await ctx.call("trips.getTrip", input) };
    } catch (error) {
      const e = error as Error & { code?: string; status?: number; body?: unknown };
      return { message: e.message, code: e.code, status: e.status, body: e.body };
    }
  },
});

async function start(
  { fetch, ...settings }: OpenApiSettings & { fetch: typeof globalThis.fetch },
  more: Plugin[] = [],
) {
  const app = definePlugin({
    name: "app",
    actions: { probe },
    resources: { openapi: { trips: settings } },
  });
  return await createRuntime({
    store: memoryStore(),
    fetch,
    plugins: [models, chat, openapi({ name: "trips", spec }), app, ...more],
  });
}

test("an Action calls the API at the spec's server, with the settings' headers", async () => {
  const api = fake(() => json({ id: "t1", name: "Lisbon" }));
  const runtime = await start({ fetch: api.fetch, headers: { authorization: "Bearer k" } });
  assertEquals(await runtime.call("trips.getTrip", { tripId: "t1" }), { id: "t1", name: "Lisbon" });
  const [asked] = api.seen;
  // The server's variable at its default.
  assertEquals([asked.method, asked.url], ["GET", "https://eu.trips.test/v1/trips/t1"]);
  assertEquals(asked.headers.get("authorization"), "Bearer k");
  assertEquals(asked.headers.get("accept"), "application/json, */*;q=0.5");
  await runtime.close();
});

test("a deployment's base URL, and a hook computing each call's headers", async () => {
  const api = fake(() => json([]));
  const hooked: unknown[] = [];
  const runtime = await start({
    fetch: api.fetch,
    baseUrl: "https://staging.trips.test/v2/",
    query: { key: "k1" },
    headers: (ctx, request) => {
      hooked.push({ actor: ctx.actor ?? null, ...request });
      return { authorization: `Bearer for-${request.operation}` };
    },
  });
  await runtime.call("trips.listTrips", { tag: ["sea"] });
  assertEquals(api.seen[0].url, "https://staging.trips.test/v2/trips?tag=sea&key=k1");
  assertEquals(api.seen[0].headers.get("authorization"), "Bearer for-listTrips");
  assertEquals(hooked, [{
    actor: null,
    operation: "listTrips",
    method: "GET",
    url: "https://staging.trips.test/v2/trips?tag=sea&key=k1",
  }]);
  await runtime.close();
});

test("a failed call says HTTP, its status and what the API said, and carries the status", async () => {
  const answers: Response[] = [
    json({ error: { code: "not_found", message: "Trip t9 doesn't exist" } }, 404),
    json({ detail: [{ loc: ["body", "name"], msg: "field required" }] }, 422),
    new Response("<html><body><h1>502 Bad Gateway</h1><hr>nginx</body></html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    }),
    new Response(null, { status: 500, statusText: "Internal Server Error" }),
  ];
  const api = fake(() => answers.shift()!);
  const runtime = await start({ fetch: api.fetch });
  const failed = await runtime.call<Record<string, unknown>>("probe", { tripId: "t9" });
  assertEquals(failed, {
    message: "HTTP 404: not_found: Trip t9 doesn't exist",
    code: "http",
    status: 404,
    body: { error: { code: "not_found", message: "Trip t9 doesn't exist" } },
  });
  const messages = [];
  for (let i = 0; i < 3; i++) {
    const { message, status } = await runtime.call<{ message: string; status: number }>(
      "probe",
      { tripId: "t9" },
    );
    messages.push([status, message]);
  }
  assertEquals(messages, [
    [422, "HTTP 422: body.name: field required"],
    [502, "HTTP 502: 502 Bad Gateway nginx"],
    [500, "HTTP 500 Internal Server Error"],
  ]);
  // Bounded: what the API said is cut at 500 characters.
  answers.push(json({ message: "y".repeat(5000) }, 400));
  const long = await runtime.call<{ message: string }>("probe", { tripId: "t9" });
  assertEquals(long.message.length, "HTTP 400: ".length + 500);
  // From outside, the error says the same, with its code.
  answers.push(json({ message: "Nope" }, 403));
  await assertRejects(
    () => runtime.call("trips.getTrip", { tripId: "t9" }),
    Error,
    "HTTP 403: Nope",
  );
  await runtime.close();
});

test("a call slower than the timeout fails; one its caller stops is stopped", async () => {
  const hang = (seen: Seen) =>
    new Promise<Response>((_, reject) => {
      seen.signal!.addEventListener("abort", () => reject(seen.signal!.reason), { once: true });
    });
  const api = fake(hang);
  const runtime = await start({ fetch: api.fetch, timeout: 50 });
  const failed = await runtime.call<{ message: string; code: string }>("probe", { tripId: "t1" });
  assertEquals([failed.code, failed.message], [
    "timeout",
    "No response from eu.trips.test within 50 ms",
  ]);
  await runtime.close();

  const slow = fake(hang);
  const patient = await start({ fetch: slow.fetch });
  const call = patient.call("trips.getTrip", { tripId: "t1" }, { id: "slow-1" });
  while (!slow.seen.length) await new Promise((resolve) => setTimeout(resolve, 5));
  assert(await patient.cancel({ call: "slow-1" }));
  await assertRejects(() => call);
  assert(slow.seen[0].signal!.aborted, "the request was stopped too");
  await patient.close();
});

test("a response larger than maxBytes fails, by what it says it is or as it streams", async () => {
  const big = "z".repeat(2000);
  const answers = [
    new Response(big, { headers: { "content-type": "text/plain", "content-length": "2000" } }),
    // No length said: counted as it comes.
    new Response(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < 4; i++) {
            controller.enqueue(new TextEncoder().encode(big.slice(0, 500)));
          }
          controller.close();
        },
      }),
      { headers: { "content-type": "text/plain" } },
    ),
    new Response("small", { headers: { "content-type": "text/plain" } }),
  ];
  const api = fake(() => answers.shift()!);
  const runtime = await start({ fetch: api.fetch, maxBytes: 1000 });
  for (let i = 0; i < 2; i++) {
    await assertRejects(
      () => runtime.call("trips.getTrip", { tripId: "t1" }),
      Error,
      "The response to GET /trips/{tripId} is larger than 1 KB (its maxBytes)",
    );
  }
  assertEquals(await runtime.call("trips.getTrip", { tripId: "t1" }), "small");
  await runtime.close();
});

test("text comes back as text, a file as a data URL, no content as null", async () => {
  const answers = [
    new Response("plain words", { headers: { "content-type": "text/plain; charset=utf-8" } }),
    new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]), {
      headers: { "content-type": "image/png" },
    }),
    new Response(null, { status: 204 }),
    // JSON that says it is, and isn't: its text.
    new Response("{oops", { headers: { "content-type": "application/json" } }),
  ];
  const api = fake(() => answers.shift()!);
  const runtime = await start({ fetch: api.fetch });
  assertEquals(await runtime.call("trips.getTrip", { tripId: "t1" }), "plain words");
  assertEquals(
    await runtime.call("trips.get_trips_tripId_photo", { tripId: "t1" }),
    "data:image/png;base64,iVBORwEC",
  );
  assertEquals(await runtime.call("trips.cancelTrip", { tripId: "t1" }), null);
  assertEquals(api.seen[2].method, "DELETE");
  assertEquals(await runtime.call("trips.getTrip", { tripId: "t1" }), "{oops");
  await runtime.close();
});

test("an input the operation doesn't take is refused before any call", async () => {
  const api = fake(() => json({}));
  const runtime = await start({ fetch: api.fetch });
  await assertRejects(() => runtime.call("trips.getTrip", {}), Error, "required");
  await assertRejects(
    () => runtime.call("trips.listTrips", { status: "lost" }),
    Error,
    "does not match any of",
  );
  assertEquals(api.seen.length, 0);
  await runtime.close();
});

test("settings that can't work stop the runtime from starting", async () => {
  const relative = { ...spec, servers: [{ url: "/v1" }] };
  await assertRejects(
    () =>
      createRuntime({
        store: memoryStore(),
        plugins: [models, chat, openapi({ name: "rel", spec: relative })],
      }),
    Error,
    'OpenAPI "rel": no base URL (the spec\'s server is "/v1"): set resources.openapi.rel.baseUrl',
  );
  // With one, it starts.
  const based = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, openapi({ name: "rel", spec: relative, baseUrl: "https://t.test" })],
  });
  await based.close();
  await assertRejects(
    () => start({ files: { nope: ["image"] } }),
    Error,
    'files names "nope", not one of its operations',
  );
  await assertRejects(() => start({ timeout: 0 }), Error, "timeout must be a positive number");
});
