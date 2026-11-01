/**
 * An org brings its own keys for model providers: any provider in the catalog
 * with an address of its own and a protocol we speak can be offered and chosen;
 * its owners and admins add a key, which is sealed and shows only its end; its
 * agents' calls to that provider use it, over the app's. A key is in no event,
 * and nobody but a model call opens it. A secret of a space's environment isn't
 * in an event either.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { type Actor, createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, {
  type LlmAdapter,
  type OfferedModel,
  type OfferedProvider,
} from "../../models/mod.ts";
import { chat, type Message } from "../../agents/chat/mod.ts";
import { computers } from "../../compute/mod.ts";
import { access } from "../mod.ts";
import { accounts } from "../accounts/mod.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const CANARY = "sk-canary-0123456789-WXYZ";

/** What each call was sent with, and every event and use seen. */
let sent: { adapter: string; apiKey?: string; baseURL?: string; model: string }[] = [];
let seen: string[] = [];
let uses: { subject: string; tags?: Record<string, string> }[] = [];

const capture = (adapter: string): LlmAdapter => ({
  async *generate({ connection }) {
    sent.push({
      adapter,
      apiKey: connection.apiKey,
      baseURL: connection.baseURL,
      model: connection.model,
    });
    yield { type: "text", text: "ok" };
    yield { type: "usage", input: 1, output: 1 };
  },
});

async function setup(
  fn: (rt: Awaited<ReturnType<typeof createRuntime>>, space: string) => Promise<void>,
) {
  sent = [];
  seen = [];
  uses = [];
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      accounts,
      computers,
      definePlugin({
        name: "app",
        adapters: {
          llm: {
            "openai-compatible": capture("openai-compatible"),
            anthropic: capture("anthropic"),
          },
        },
        processors: {
          everything: {
            on: "*",
            run: (event: unknown) => {
              seen.push(JSON.stringify(event));
            },
          },
        },
        resources: {
          accounts: { key: "a-long-enough-secret-for-sealing-keys" },
          computers: { key: "another-long-enough-secret-for-sealing" },
          provider: { anthropic: { apiKey: "the-apps-key" } },
          modelUse: {
          test: {
            used: (_ctx: unknown, use: { subject: string; tags?: Record<string, string> }) => {
              uses.push(use);
            },
          },
        },
        shared: { thread: {}, message: {} },
          agents: {
            keyed: { instructions: "Hi.", model: "groq/llama-3.3-70b-versatile", default: true },
            app: { instructions: "Hi.", model: "anthropic/claude-opus-5-5" },
            chain: {
              instructions: "Hi.",
              model: ["groq/llama-3.3-70b-versatile", "anthropic/claude-opus-5-5"],
            },
          },
        },
      }),
    ],
  });
  try {
    await rt.call("org.join", { person: "ana", role: "owner" });
    await rt.call("org.join", { person: "bob" });
    const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    for (const agent of ["app", "chain"]) {
      await rt.call("member.set", { space, member: { kind: "agent", id: agent }, role: "editor" }, {
        actor: ana,
      });
    }
    await fn(rt, space);
  } finally {
    await rt.close();
  }
}

type Rt = Awaited<ReturnType<typeof createRuntime>>;
const offered = <T>(rt: Rt, input: Record<string, unknown> = {}, actor = ana) =>
  rt.call<T>("models.offered", input, { actor });

/** A turn; its last message. */
async function ask(rt: Rt, space: string, text: string) {
  const { thread } = await rt.call<{ thread: string }>("chat.send", { in: space, text }, {
    actor: ana,
  });
  await rt.idle();
  return (await rt.query<Message[]>("message.history", { thread }, { actor: ana })).at(-1)!;
}

test("what's offered: providers with an address and a protocol, models an agent can use", async () => {
  await setup(async (rt) => {
    const { providers, set } = await offered<{ providers: OfferedProvider[]; set: boolean }>(rt);
    assertEquals(set, true);
    const ids = providers.map((p) => p.id);
    assert(ids.includes("groq") && ids.includes("openai") && ids.includes("google"));
    // Ready first: the app's key.
    assertEquals(providers[0].id, "anthropic");
    assertEquals([providers[0].ready, providers[0].keyed], [true, true]);
    assertEquals(providers.find((p) => p.id === "groq")!.ready, false);
    // No address of its own: its key would go somewhere else. No protocol of ours: nothing to call.
    for (const out of ["lmstudio", "databricks", "amazon-bedrock", "azure", "fake", "hash"]) {
      assert(!ids.includes(out), out);
    }
    assert(providers.length > 150, `${providers.length} providers`);

    const { models: listed } = await offered<{ models: OfferedModel[] }>(rt, {
      provider: "anthropic",
    });
    assert(
      listed.some((m) => m.id === "anthropic/claude-opus-5-5" && m.name === "Claude Opus 5.5"),
    );
    assert(listed.every((m) => m.ready));
    const released = listed.map((m) => m.released ?? "").filter(Boolean);
    assertEquals(released, [...released].sort().reverse());

    const found = await offered<{ providers: OfferedProvider[]; models: OfferedModel[] }>(rt, {
      search: "opus 5.5",
    });
    assert(found.models.some((m) => m.id === "anthropic/claude-opus-5-5"));
    // Those that can be used come first.
    assertEquals(found.models[0].ready, true);

    const one = await offered<{ model: OfferedModel; provider: OfferedProvider }>(rt, {
      model: "anthropic/claude-opus-5-5",
    });
    assertEquals([one.model.name, one.provider.name], ["Claude Opus 5.5", "Anthropic"]);
  });
});

test("an org's owners add a key; it shows its end, and is in no event", async () => {
  await setup(async (rt) => {
    const made = await rt.call<{ hint: string }>("modelKey.set", {
      provider: "groq",
      key: `  ${CANARY} `,
    }, { actor: ana });
    assertEquals(made.hint, "••••WXYZ");
    const groq = async () =>
      (await offered<{ providers: OfferedProvider[] }>(rt)).providers.find((p) => p.id === "groq")!;
    assertEquals([(await groq()).ready, (await groq()).hint], [true, "••••WXYZ"]);
    await rt.idle();

    // Nobody else changes it, or opens it, or reads it.
    await assertRejects(
      () => rt.call("modelKey.set", { provider: "groq", key: "x" }, { actor: bob }),
      Error,
      "owners and admins",
    );
    await assertRejects(() => rt.call("modelKey.remove", { provider: "groq" }, { actor: bob }));
    await assertRejects(() => rt.call("modelKey.open", { provider: "groq" }, { actor: ana }));
    await assertRejects(() => rt.call("modelKey.list", {}, { actor: ana }));
    assertEquals(await offered<{ set: boolean }>(rt, {}, bob).then((o) => o.set), false);
    // A provider that can't take one is refused.
    await assertRejects(
      () => rt.call("modelKey.set", { provider: "lmstudio", key: "x" }, { actor: ana }),
      Error,
      "can't be added",
    );

    // Sealed where it's kept, and nowhere in the log, or what's offered.
    const kept = await rt.call<string | null>("modelKey.open", { provider: "groq" });
    assertEquals(kept, CANARY);
    assert(seen.length > 0, "events were seen");
    assert(!seen.some((event) => event.includes(CANARY)), "a key in an event");
    assert(!JSON.stringify(await offered(rt)).includes(CANARY), "a key in what's offered");

    await rt.call("modelKey.remove", { provider: "groq" }, { actor: ana });
    assertEquals((await groq()).ready, false);
  });
});

test("an org's key goes on its calls, at the catalog's address, over the app's", async () => {
  await setup(async (rt, space) => {
    // No key, and nothing else to try: it says so.
    const told = await ask(rt, space, "hello");
    assertStringIncludes(JSON.stringify(told), "no key for groq");
    assertEquals(sent, []);

    await rt.call("modelKey.set", { provider: "groq", key: CANARY }, { actor: ana });
    await ask(rt, space, "hello");
    assertEquals(sent.at(-1), {
      adapter: "openai-compatible",
      apiKey: CANARY,
      baseURL: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b-versatile",
    });
    assertEquals(uses.at(-1)?.tags?.paid, "own-key");

    // The app's key, until the org has one of its own.
    await ask(rt, space, "@app hello");
    assertEquals(sent.at(-1)?.apiKey, "the-apps-key");
    assertEquals(uses.at(-1)?.tags?.paid, undefined);
    await rt.call("modelKey.set", { provider: "anthropic", key: CANARY }, { actor: ana });
    await ask(rt, space, "@app hello");
    assertEquals(sent.at(-1)?.apiKey, CANARY);
    await rt.call("modelKey.remove", { provider: "anthropic" }, { actor: ana });
    await ask(rt, space, "@app hello");
    assertEquals(sent.at(-1)?.apiKey, "the-apps-key");
    await rt.idle();
    assert(!seen.some((event) => event.includes(CANARY)), "a key in an event");
  });
});

test("a list moves on from a provider with no key", async () => {
  await setup(async (rt, space) => {
    await ask(rt, space, "@chain hello");
    assertEquals(sent.at(-1)?.adapter, "anthropic");
  });
});

test("a secret of a space's environment is in no event", async () => {
  await setup(async (rt, space) => {
    await rt.call("env.set", { in: space, name: "API_TOKEN", value: CANARY, secret: true }, {
      actor: ana,
    });
    await rt.idle();
    assert(seen.length > 0, "events were seen");
    assert(!seen.some((event) => event.includes(CANARY)), "a secret in an event");
  });
});
