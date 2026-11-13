/**
 * The docs app's shape, measured in a process of its own (budget.test.ts runs it, with the GC
 * exposed): copilotz.com's docs app, as the memory harness has it. One plugin of three read-only
 * tools, offered over MCP (`mcp`, after `models`, `chat` and the access plugins it requires), on
 * the memory store, each plugin from its own entry point. Its pages come from a small source made
 * on the fly, so what's measured is Copilotz.
 *
 * It prints one line of JSON: RSS and heap used after a full GC once loaded, once started and
 * called once, after `WARM` calls and after `CALLS` (each MCP `tools/call` a new conversation),
 * how many failed, and whether the model catalog was loaded (nothing here resolves a model).
 *
 *   deno run -A --v8-flags=--expose-gc bench/memory/docs-app.ts [calls]
 *   node --expose-gc bench/memory/docs-app.ts [calls]
 */
import process from "node:process";
import {
  createRuntime,
  defineAction,
  definePlugin,
  type JSONSchema,
  type Plugin,
  type Runtime,
} from "../../runtime/mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { models } from "../../plugins/models/mod.ts";
import { catalog } from "../../plugins/models/shared/choice.ts";
import { chat, tool } from "../../plugins/agents/chat/mod.ts";
import { spaces } from "../../plugins/access/spaces/mod.ts";
import { identity } from "../../plugins/access/identity/mod.ts";
import { contacts } from "../../plugins/access/contacts/mod.ts";
import { mcp } from "../../plugins/interfaces/mcp/mod.ts";

const CALLS = Number(process.argv[2] ?? 200);
/** Calls before the per-call growth is measured: what the first ones fill (caches, code) aside. */
const WARM = Math.min(50, CALLS);
const ORIGIN = "https://docs.example";
const WORDS = ("runtime plugin action collection view processor resource adapter actor space " +
  "contact chat agent tool model store event commit query rule guard schedule").split(" ");

// deno-lint-ignore no-explicit-any
const g = globalThis as any;
if (typeof g.gc !== "function") throw new Error("run with the GC exposed (--expose-gc)");

/** RSS and heap used (bytes) after a full collection, a few times over. */
async function reading() {
  for (let i = 0; i < 4; i++) {
    g.gc();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const { rss, heapUsed } = g.Deno ? g.Deno.memoryUsage() : process.memoryUsage();
  return { rss, heapUsed };
}

/** Deterministic text of `bytes` characters. */
function text(seed: number, bytes: number): string {
  let out = "";
  let x = seed * 2654435761 >>> 0;
  while (out.length < bytes) {
    x = (x * 1103515245 + 12345) >>> 0;
    out += WORDS[x % WORDS.length] + ((x >> 8) % 11 === 0 ? ".\n" : " ");
  }
  return out.slice(0, bytes);
}

const object = (properties: Record<string, JSONSchema>, required: string[] = []): JSONSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const reads = { readOnly: true, openWorld: false };
const anyone = () => true;
const json = (call: { output: string }) => {
  try {
    return call.output.startsWith("Error: ") ? undefined : JSON.parse(call.output);
  } catch {
    return undefined;
  }
};

/** The docs: search, read a page, the guide; unrecorded Actions, a tool and a View for each. */
const docs: Plugin = definePlugin({
  name: "docs",
  actions: {
    "docs.search": defineAction({
      description: "Searches the docs",
      input: object({ query: { type: "string", minLength: 1 }, limit: { type: "integer" } }, [
        "query",
      ]),
      allow: anyone,
      record: false,
      run: (_ctx, input) => {
        const { query, limit } = input as { query: string; limit?: number };
        const results = Array.from({ length: Math.min(limit ?? 5, 10) }, (_, i) => ({
          title: `Page ${i}`,
          slug: `guides/page-${i}`,
          url: `${ORIGIN}/docs/guides/page-${i}`,
          snippet: text(query.length + i, 180),
        }));
        return { query, results };
      },
    }),
    "docs.read": defineAction({
      description: "Reads a docs page",
      input: object({ slug: { type: "string", minLength: 1 } }, ["slug"]),
      allow: anyone,
      record: false,
      run: (_ctx, input) => {
        const { slug } = input as { slug: string };
        const n = Number(/(\d+)$/.exec(slug)?.[1] ?? 0);
        return { slug, title: `Page ${n}`, markdown: `# Page ${n}\n\n${text(n + 1, 6_000)}` };
      },
    }),
    "docs.guide": defineAction({
      description: "AGENTS.md",
      input: object({}),
      allow: anyone,
      record: false,
      run: () => ({ markdown: `# AGENTS.md\n\n${text(7, 19_000)}` }),
    }),
  },
  views: {
    "tool:search_docs": (call) => {
      const found = json(call);
      if (!found) return call.output;
      return (found.results as { title: string; slug: string; snippet: string }[])
        .map((r, i) => `${i + 1}. ${r.title}\n   slug: ${r.slug}\n   ${r.snippet}`).join("\n\n");
    },
    "tool:read_doc": (call) => json(call)?.markdown ?? call.output,
    "tool:agents_guide": (call) => json(call)?.markdown ?? call.output,
  },
  resources: {
    tools: {
      search_docs: tool({
        title: "Search the docs",
        description: "Searches the documentation and returns the pages that best answer a query.",
        input: object({ query: { type: "string" }, limit: { type: "integer" } }, ["query"]),
        annotations: reads,
        run: (input, ctx) => ctx.call("docs.search", input),
      }),
      read_doc: tool({
        title: "Read a docs page",
        description: "Reads one page of the documentation as markdown, by its slug.",
        input: object({ slug: { type: "string" } }, ["slug"]),
        annotations: reads,
        run: (input, ctx) => ctx.call("docs.read", input),
      }),
      agents_guide: tool({
        title: "The coding agents' guide",
        description: "Returns AGENTS.md.",
        input: object({}),
        annotations: reads,
        run: (_input, ctx) => ctx.call("docs.guide", {}),
      }),
    },
  },
});

/** Its settings: the MCP server at /mcp/docs, with limits raised so every call is taken. */
const many = 1_000_000;
const site: Plugin = definePlugin({
  name: "docs-site",
  resources: {
    links: { origin: ORIGIN, secret: "0123456789abcdef".repeat(4) },
    mcp: {
      docs: {
        in: "docs",
        client: "Assistant",
        title: "Copilotz docs",
        instructions: "The Copilotz documentation.",
        origins: ["*"],
        tools: { search_docs: {}, read_doc: {}, agents_guide: {} },
        limits: {
          atOnce: 16,
          addressAtOnce: 16,
          chatAtOnce: 4,
          perMinute: many,
          linePerMinute: many,
          chatsPerHour: many,
          userChatsPerHour: many,
          ipPerMinute: many,
          ipChatsPerHour: many,
        },
      },
    },
  },
});

/** One MCP `tools/call` through `runtime.fetch`, as a client naming no conversation: whether it answered. */
async function call(runtime: Runtime, id: number): Promise<boolean> {
  const read = id % 2 === 0;
  const response = await runtime.fetch(
    new Request(`${ORIGIN}/mcp/docs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: read
          ? { name: "read_doc", arguments: { slug: `guides/page-${id % 50}` } }
          : { name: "search_docs", arguments: { query: `how do I ${WORDS[id % WORDS.length]}` } },
      }),
    }),
  );
  const body = await response.text();
  if (response.status !== 200) return false;
  try {
    const answer = JSON.parse(body);
    return !answer.error && !answer.result?.isError && !!answer.result?.content?.[0]?.text;
  } catch {
    return false;
  }
}

const loaded = await reading();
const runtime = await createRuntime({
  store: memoryStore(),
  plugins: [models, chat, spaces, identity, contacts, mcp, docs, site],
});
let failed = (await call(runtime, 0)) ? 0 : 1;
await runtime.idle();
const started = await reading();
let warm = started;
for (let i = 1; i <= CALLS; i++) {
  if (!(await call(runtime, i))) failed++;
  if (i === WARM) {
    await runtime.idle();
    warm = await reading();
  }
}
await runtime.idle();
const end = await reading();
let catalogLoaded = true;
try {
  void catalog.fetched;
} catch {
  catalogLoaded = false;
}
await runtime.close();
console.log(
  JSON.stringify({
    calls: CALLS,
    warm: WARM,
    failed,
    catalogLoaded,
    loaded,
    started,
    warmed: warm,
    end,
  }),
);
process.exit(0);
