/**
 * What a web line's visitor sees of its agent at work, over the real socket
 * (Oxian's Node adapter, as a browser connects): its live watch shows the
 * agent at work, never a step's words before it's known to be an answer
 * (an agent with tools may be writing a private step: what it's about to
 * look up, and for whom), never its tool calls, and never why a model's call
 * broke (a provider's own words: its org, its limits). An agent with no tools
 * only answers: its words show as they're written. A person's own turn with
 * tools streams to them as before.
 */
import { assert, assertEquals } from "@std/assert";
import {
  type Actor,
  createRuntime,
  definePlugin,
  type Runtime,
  type ViewContext,
} from "../../../../runtime/mod.ts";
import { type Client, connect } from "../../../../runtime/client.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../../../plugins/models/mod.ts";
import { chat, tool } from "../../../../plugins/agents/chat/mod.ts";
import { access } from "../../../../plugins/access/mod.ts";
import { webLines } from "../../../../plugins/interfaces/web/lines.ts";
import { test } from "../../../../testing/mod.ts";
import { socket } from "../../server.ts";
import { createTickets } from "../../tickets.ts";
import { serve, type Server } from "../mod.ts";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether the next call to the booking agent breaks first (a provider's rate limit). */
let breakOnce = false;

/**
 * The booking agent (`script/main`, with a tool): it says what it's about to
 * look up, and for whom, then looks; then answers. The greeter
 * (`script/chatty`, no tools) only answers.
 */
const script: LlmAdapter = {
  async *generate({ connection, messages }) {
    if (connection.model === "chatty") {
      yield { type: "text", text: "Hello there, " };
      await pause(150);
      yield { type: "text", text: "how can I help?" };
      await pause(150);
      return;
    }
    if (breakOnce) {
      breakOnce = false;
      throw Object.assign(
        new Error(
          "OpenAI 429: Rate limit reached for gpt-5.6 in organization org-ACME1234 on tokens " +
            "per min (TPM): Limit 30000, Used 29870.",
        ),
        { status: 429 },
      );
    }
    // Thinking, before its first word: the agent at work.
    await pause(150);
    if (messages.at(-1)!.role === "tool") {
      yield { type: "text", text: "We have " };
      await pause(150);
      yield { type: "text", text: "rooms." };
      return;
    }
    yield { type: "text", text: "Checking the supplier sheet (cost 41.20 EUR) " };
    await pause(150);
    yield { type: "text", text: "for Maria Silva's hold B-1182…" };
    await pause(150);
    yield {
      type: "tool_call",
      call: { id: "s1", name: "stock", input: { secretArg: "SUPPLIER-KEY-XYZ" } },
    };
  },
};

const app = definePlugin({
  name: "app",
  resources: {
    provider: { script: { adapter: "script" } },
    agents: {
      // The app's default: it works in every space people make too.
      guide: { instructions: "x", model: "script/main", tools: ["stock"], default: true },
      chatty: { instructions: "x", model: "script/chatty" },
      // Its only tool is called beside an answer (hanging up): it only answers too.
      polite: { instructions: "x", model: "script/chatty", tools: ["bye"] },
    },
    tools: {
      stock: tool({ description: "s", run: async () => (await pause(200), "INTERNAL 3 rooms") }),
      bye: tool({ description: "b", aside: true, run: () => "ok" }),
    },
    spaces: { visitors: { name: "Website", agents: ["guide", "chatty", "polite"] } },
    web: {
      site: { in: "visitors", agent: "guide" },
      talk: { in: "visitors", agent: "chatty" },
      bye: { in: "visitors", agent: "polite" },
    },
    links: { origin: "http://127.0.0.1", secret: "the-app-secret-for-tests-0123456789" },
  },
  adapters: { llm: { script } },
});

/** The page's front end: what a browser reads, as whoever it is. */
const page = definePlugin({
  name: "page",
  views: {
    live: (thread: string, ctx: ViewContext) =>
      ctx.db.collection("live").find({ thread }).value ?? [],
    said: (thread: string, ctx: ViewContext) =>
      (ctx.db.collection<{ text?: string }>("message").find({ thread }).value ?? [])
        .map((m) => m.text ?? ""),
  },
});

type LiveDoc = { text: string; calls?: unknown[]; retry?: unknown; open?: boolean };

/** A visitor's way in, and its browser on the socket. */
async function visitor(server: Server, line: string): Promise<Client> {
  const response = await fetch(`${server.url.origin}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: server.url.origin },
    body: JSON.stringify({ line }),
  });
  assertEquals(response.status, 200);
  const { ticket } = await response.json() as { ticket: string; actor: Actor };
  const client = connect({
    transport: {
      type: "websocket",
      config: {
        url: `ws://127.0.0.1:${server.port}${socket.config.path}`,
        allowInsecureLoopback: true,
      },
    },
    ticket: () => Promise.resolve(ticket),
    plugins: [page],
  });
  await client.ready;
  return client;
}

/** Everything a watch on `view` was shown, until `done` holds. */
async function watched(
  observe: () => {
    get(): unknown;
    subscribe(listener: () => void): () => void;
    close(): void;
  },
  done: () => Promise<boolean>,
): Promise<LiveDoc[][]> {
  const shown: LiveDoc[][] = [];
  const watch = observe();
  const off = watch.subscribe(() => {
    const output = watch.get() as { status: string; value?: LiveDoc[] };
    if (output.status === "ready") shown.push(structuredClone(output.value ?? []));
  });
  try {
    for (let i = 0; i < 400 && !await done(); i++) await pause(25);
    assert(await done(), "the agent answered");
    await pause(100);
  } finally {
    off();
    watch.close();
  }
  return shown;
}

/** Whether a thread has its agent's answer. */
const answered = (runtime: Runtime, thread: string) => async () =>
  (await runtime.query<{ _id: string }[]>("message.history", { thread }))
    .some((m) => m._id.endsWith(":reply"));

async function setup(fn: (server: Server, runtime: Runtime) => Promise<void>) {
  breakOnce = false;
  const tickets = createTickets();
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, webLines, app, page],
    transports: [socket],
    admit: tickets.admit,
  });
  let server: Server | undefined;
  try {
    server = await serve({ runtime, tickets, code: { entry: "app.js", files: { "app.js": "" } } });
    await fn(server, runtime);
  } finally {
    if (server) await server.close();
    else await runtime.close();
  }
}

test("a visitor sees its agent at work, never a step's words, its calls, nor why a call broke", async () => {
  await setup(async (server, runtime) => {
    const client = await visitor(server, "site");
    try {
      breakOnce = true;
      const { thread } = await client.call<{ thread: string }>("chat.send", { text: "rooms?" });
      const shown = await watched(
        () => client.observe<LiveDoc[]>("live", thread),
        answered(runtime, thread),
      );
      const docs = shown.flat();
      const words = JSON.stringify(shown);
      console.log(`live pushes: ${shown.length}; what they showed: ${words.slice(0, 300)}`);
      // It saw the agent at work.
      assert(docs.length > 0, "the visitor saw the agent at work");
      // Never what a step said before its call, nor its calls, nor the provider's words.
      assert(!words.includes("supplier") && !words.includes("Maria"), "no step's words");
      assert(!words.includes("SUPPLIER-KEY-XYZ"), "no tool call's input");
      assert(!words.includes("org-ACME1234"), "no provider's words");
      assertEquals(docs.filter((d) => d.calls?.length || d.retry).length, 0);
      // Its answer comes as the agent's message.
      const said = client.observe<string[]>("said", thread);
      try {
        const output = await said.ready;
        assert(output.status === "ready" && output.value.includes("We have rooms."));
      } finally {
        said.close();
      }
    } finally {
      await client.close();
    }
  });
});

test("an agent with no tools only answers: a visitor sees its words as they're written", async () => {
  await setup(async (server, runtime) => {
    const client = await visitor(server, "talk");
    try {
      const { thread } = await client.call<{ thread: string }>("chat.send", { text: "hi" });
      const shown = await watched(
        () => client.observe<LiveDoc[]>("live", thread),
        answered(runtime, thread),
      );
      const texts = shown.flat().map((d) => d.text);
      console.log(`what the visitor saw being written: ${JSON.stringify(texts)}`);
      assert(texts.some((t) => t.startsWith("Hello there")), "its words, as they came");
    } finally {
      await client.close();
    }
  });
});

test("an agent whose only tools go beside an answer (aside) only answers too: its words as written", async () => {
  await setup(async (server, runtime) => {
    const client = await visitor(server, "bye");
    try {
      const { thread } = await client.call<{ thread: string }>("chat.send", { text: "hi" });
      const shown = await watched(
        () => client.observe<LiveDoc[]>("live", thread),
        answered(runtime, thread),
      );
      assert(shown.flat().some((d) => d.text.startsWith("Hello there")), "its words, as they came");
    } finally {
      await client.close();
    }
  });
});

test("a person's own turn with tools streams its words to them, as before", async () => {
  await setup(async (_, runtime) => {
    const ana = { kind: "person", id: "ana" };
    await runtime.call("space.create", { id: "team", name: "Team" }, { actor: ana });
    const { thread } = await runtime.call<{ thread: string }>(
      "chat.send",
      { text: "rooms?", in: "team", to: ["guide"] },
      { actor: ana },
    );
    const shown = await watched(
      () => runtime.observe<LiveDoc[]>("live", thread, { actor: ana }),
      answered(runtime, thread),
    );
    const texts = shown.flat().map((d) => d.text);
    console.log(`what ana saw being written: ${JSON.stringify(texts)}`);
    assert(texts.some((t) => t.includes("Checking the supplier sheet")), "the step's words");
    assert(texts.some((t) => t.includes("We have")), "the answer's words");
  });
});
