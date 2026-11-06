/**
 * The tools, end to end: an agent (a scripted model) calls an operation's
 * tool in a conversation and reads what the API returned. A turn tried again
 * gets the call it already made back instead of calling the API twice; an
 * API's error is what the agent reads; files in a response become the
 * conversation's files, and the agent gets a reference, never the base64.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createRuntime, definePlugin, type Plugin } from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import models, { type LlmAdapter, type LlmMessage } from "../../../models/mod.ts";
import { chat, type FileAbout, type Message, type Step, type Tool } from "../../chat/mod.ts";
import { openapi, type OpenApiFile, type OpenApiSettings } from "../mod.ts";
import { test } from "../../../../testing/mod.ts";
import { fake, json } from "./fake.ts";
import spec from "./trips.json" with { type: "json" };

type Call = { name: string; input: Record<string, unknown> };
/** The agent's next move: tool calls, or its answer. */
type Script = (seen: { messages: LlmMessage[]; turn: number }) => string | Call[];

const PNG = "iVBORw0KGgo="; // A PNG's first 8 bytes, as base64.

async function start(
  script: Script,
  { fetch, ...settings }: OpenApiSettings & { fetch?: typeof globalThis.fetch },
  { tools = ["trips_getTrip"], more = [] }: { tools?: string[]; more?: Plugin[] } = {},
) {
  const calls: { messages: LlmMessage[]; tools: string[]; offered: unknown[] }[] = [];
  const scripted: LlmAdapter = {
    async *generate({ messages, tools }) {
      const turn = calls.length;
      calls.push({ messages, tools: (tools ?? []).map((t) => t.name), offered: tools ?? [] });
      const move = script({ messages, turn });
      if (typeof move === "string") return yield { type: "text", text: move };
      for (const [i, call] of move.entries()) {
        yield { type: "tool_call", call: { id: `c${turn}.${i}`, ...call } };
      }
    },
  };
  const app = definePlugin({
    name: "app",
    resources: {
      provider: { script: { adapter: "script" } },
      agents: { planner: { instructions: "Plan trips.", model: "script/planner", tools } },
      openapi: { trips: settings },
    },
    adapters: { llm: { script: scripted } },
  });
  const store = memoryStore();
  const runtime = await createRuntime({
    store,
    fetch,
    plugins: [models, chat, openapi({ name: "trips", spec }), app, ...more],
  });
  const ask = async (text: string) => {
    const { thread } = await runtime.call<{ thread: string }>("chat.send", { text, from: "ana" });
    await runtime.idle();
    const messages = await runtime.query<Message[]>("message.history", { thread });
    const steps = messages.flatMap((m) => (m.toolCalls ?? []) as Step[]);
    return { thread, messages, outputs: steps.map((s) => s.output) };
  };
  return { runtime, store, calls, ask };
}

/** The text of the last tool result the model was sent. */
const lastTool = (messages: LlmMessage[]) =>
  (messages.findLast((m) => m.role === "tool") as { text: string } | undefined)?.text ?? "";

test("an agent calls an operation's tool and reads what the API returned", async () => {
  const api = fake(() => json({ id: "t1", name: "Lisbon", legs: [] }));
  const { runtime, calls, ask } = await start(
    ({ turn, messages }) =>
      turn === 0
        ? [{ name: "trips_getTrip", input: { tripId: "t1" } }]
        : `Found: ${lastTool(messages)}`,
    { fetch: api.fetch },
  );
  const { messages, outputs } = await ask("What's trip t1?");
  assertEquals(api.seen.map((s) => s.url), ["https://eu.trips.test/v1/trips/t1"]);
  assertEquals(outputs, ['{"id":"t1","name":"Lisbon","legs":[]}']);
  assertEquals(messages.at(-1)!.text, 'Found: {"id":"t1","name":"Lisbon","legs":[]}');
  // It's offered only the tool it lists: the API's others are for code.
  assertEquals(calls[0].tools, ["trips_getTrip"]);
  await runtime.close();
});

test("a retried turn gets the call it already made back, and doesn't call the API again", async () => {
  const api = fake(() => json({ id: "t2", name: "Porto" }, 201));
  // The turn fails once after its call ran, before its step committed: it's tried again.
  let shown = 0;
  const flaky = definePlugin({
    name: "flaky",
    views: {
      "tool:trips_createTrip": (step: Step) => {
        if (++shown === 1) throw new Error("lost the turn");
        return step.output;
      },
    },
  });
  const { runtime, store, calls, ask } = await start(
    ({ messages }) =>
      messages.some((m) => m.role === "tool")
        ? `Planned: ${lastTool(messages)}`
        : [{ name: "trips_createTrip", input: { name: "Porto", "Idempotency-Key": "k1" } }],
    { fetch: api.fetch },
    { tools: ["trips_createTrip"], more: [flaky] },
  );
  const { messages, outputs } = await ask("Plan Porto");
  // The retried turn goes on with the call it had written (the model isn't asked for it again:
  // once for the call, once for the answer), and the API heard it once.
  assertEquals(calls.length, 2);
  assertEquals(api.seen.length, 1);
  assertEquals(JSON.parse(api.seen[0].body!), { name: "Porto" });
  assertEquals(outputs, ['{"id":"t2","name":"Porto"}']);
  assertEquals(messages.at(-1)!.text, 'Planned: {"id":"t2","name":"Porto"}');
  const recorded = (await store.events(0)).filter((e) => e.data.action === "trips.createTrip");
  assertEquals(recorded.map((e) => e.type), ["action.started", "action.completed"]);
  await runtime.close();
});

test("an API's error is what the agent reads: HTTP, its status, what the API said", async () => {
  const api = fake(() => json({ message: "Trip t9 doesn't exist" }, 404));
  const { runtime, ask } = await start(
    ({ turn }) => turn === 0 ? [{ name: "trips_getTrip", input: { tripId: "t9" } }] : "Sorry.",
    { fetch: api.fetch },
  );
  const { outputs } = await ask("Trip t9?");
  assertEquals(outputs, ["Error: HTTP 404: Trip t9 doesn't exist"]);
  await runtime.close();
});

test("files in a response are the conversation's files; the agent gets a reference", async () => {
  const answers = [
    json({ caption: "Porto to Lisbon", image: `data:image/png;base64,${PNG}` }),
    // A response that is a file is one, whole.
    new Response(Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)), {
      headers: { "content-type": "image/png" },
    }),
    // The same image again is the same file.
    json({ caption: "Again", image: PNG }),
  ];
  const api = fake(() => answers.shift()!);
  const { runtime, calls, ask } = await start(
    ({ turn }) =>
      turn === 0
        ? [
          { name: "trips_getMap", input: { tripId: "t1" } },
          { name: "trips_get_trips_tripId_photo", input: { tripId: "t1" } },
        ]
        : turn === 1
        ? [{ name: "trips_getMap", input: { tripId: "t1" } }]
        : "Here they are.",
    { fetch: api.fetch, files: { getMap: ["image"] } },
    { tools: ["trips_getMap", "trips_get_trips_tripId_photo"] },
  );
  const { thread, outputs } = await ask("Show me trip t1");
  const [map, photo, again] = outputs.map((o) => JSON.parse(o));
  const ref: OpenApiFile = { file: map.image.file, name: "getMap.png", type: "image/png", size: 8 };
  assertEquals(map, { caption: "Porto to Lisbon", image: ref });
  assertEquals(photo, { ...ref, file: photo.file, name: "get_trips_tripId_photo.png" });
  // The same image from the same operation is the same file.
  assertEquals(again, { caption: "Again", image: ref });
  assert(map.image.file.startsWith(`${thread}:file.`));
  // Kept as files of the conversation, content and all.
  const file = await runtime.query<FileAbout>("file.about", { id: map.image.file });
  assertEquals([file.thread, file.type, file.size], [thread, "image/png", 8]);
  const content = (await runtime.bytes("file", { _id: map.image.file }, "data"))!;
  assertEquals(new TextDecoder().decode(await content.read(0, content.size)), PNG);
  // The model never saw the base64.
  assert(!JSON.stringify(calls.map((c) => c.messages)).includes(PNG));
  await runtime.close();
});

test("a file of a type or size the API may not return is refused; the agent reads why", async () => {
  const answers = [
    json({ caption: "x", image: "data:image/svg+xml;base64,PHN2Zz4=" }),
    json({ caption: "x", image: PNG }),
    json({ caption: "x", image: "not base64!" }),
  ];
  const api = fake(() => answers.shift()!);
  const { runtime, ask } = await start(
    ({ turn }) => turn < 3 ? [{ name: "trips_getMap", input: { tripId: "t1" } }] : "No.",
    { fetch: api.fetch, files: { getMap: ["image"] }, maxFileBytes: 4 },
    { tools: ["trips_getMap"] },
  );
  const { outputs } = await ask("Map?");
  assertEquals(outputs, [
    "Error: The response's \"image\" is a file of type image/svg+xml, which isn't one this API " +
    "may return (its fileTypes)",
    "Error: The response's files are larger than 4 bytes (its maxFileBytes)",
    "Error: The response's \"image\" isn't a data URL or base64",
  ]);
  await runtime.close();
});

test("files are found by path, in every item; what's left must fit in maxBytes", async () => {
  const JPEG = "/9j/4AAQ"; // A JPEG's first bytes.
  const answers = [
    json({ data: [{ b64: PNG }, { b64: JPEG, note: "other" }, { b64: PNG }], caption: "three" }),
    json({ caption: "c".repeat(700), image: PNG }),
  ];
  const api = fake(() => answers.shift()!);
  const { runtime, ask } = await start(
    ({ turn }) => turn < 2 ? [{ name: "trips_getMap", input: { tripId: "t1" } }] : "Ok.",
    { fetch: api.fetch, files: { getMap: ["data.*.b64", "image"] }, maxBytes: 600 },
    { tools: ["trips_getMap"] },
  );
  const { outputs } = await ask("Maps?");
  const [png, jpeg, same] = JSON.parse(outputs[0]).data.map((d: { b64: OpenApiFile }) => d.b64);
  assertEquals([png.name, png.type, jpeg.name, jpeg.type], [
    "getMap.png",
    "image/png",
    "getMap.jpg",
    "image/jpeg",
  ]);
  assert(png.file !== jpeg.file);
  assertEquals(same, png);
  assertStringIncludes(outputs[1], "Error: The response is 848 bytes");
  assertStringIncludes(
    outputs[1],
    "more than the 600 bytes an agent is given (the API's maxBytes)",
  );
  await runtime.close();
});

test("a tool of one's own is the generated one with another run, over the same Action", async () => {
  const api = fake(() => json({ id: "t1", name: "Lisbon", legs: [{}, {}] }));
  const trips = openapi({ name: "trips", spec });
  const mine: Tool = {
    ...trips.tools.getTrip,
    run: async (input, ctx) => {
      const trip = await ctx.call<{ name: string; legs: unknown[] }>("trips.getTrip", input);
      return `${trip.name}, ${trip.legs.length} legs`;
    },
  };
  const own = definePlugin({ name: "own", resources: { tools: { trips_getTrip: mine } } });
  const { runtime, calls, ask } = await start(
    ({ turn }) => turn === 0 ? [{ name: "trips_getTrip", input: { tripId: "t1" } }] : "Ok.",
    { fetch: api.fetch },
    { more: [own] },
  );
  const { outputs } = await ask("t1?");
  assertEquals(outputs, ["Lisbon, 2 legs"]);
  assertEquals(api.seen.length, 1);
  // Its description and input are the operation's still.
  assertEquals(calls[0].offered, [{
    name: "trips_getTrip",
    description: "Get a trip, with its legs.",
    input: trips.tools.getTrip.input,
  }]);
  await runtime.close();
});
