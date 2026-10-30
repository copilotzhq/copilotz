/**
 * Connected accounts, against a stand-in for OpenAI (its OAuth server and
 * ChatGPT's backend): connecting a ChatGPT plan by pasting back where its
 * sign-in lands (PKCE, a state bound to its person, used once); agents
 * running on the plan of the person they work for, and on the app's model
 * without one; metering as the person's plan, at no cost to the app;
 * renewing tokens on their timer and as they're used (once at a time);
 * losing an account the provider refuses; disconnecting; sealing tokens at
 * rest; and nothing secret anywhere it shouldn't be: events, Views,
 * queries, errors, logs, other people.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Filter,
  manualClock,
  type Store,
  type ViewContext,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import models, { type Completion } from "../../models/mod.ts";
import { chat, type Message } from "../../agents/chat/mod.ts";
import { usage } from "../../billing/mod.ts";
import { access } from "../mod.ts";
import { type Account, accounts, type Connecting, type ProviderShown } from "../accounts/mod.ts";
import { env, tempFile, temporary, test } from "../../../testing/mod.ts";
import { postgresStore } from "../../../stores/sql/postgres/mod.ts";
import { CLIENT, type FakeOpenAI, fakeOpenAI } from "./openai-fake.ts";
import type { AccountDoc } from "../accounts/collections/account.ts";
import { renew } from "../accounts/shared/renew.ts";
import { providersOf } from "../accounts/shared/settings.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
/** The agent, working for someone, as a turn runs. */
const lead = (person: Actor): Actor => ({ kind: "agent", id: "lead", for: person });
const PLAN = ["chatgpt/gpt-6.1-sol", "fake/echo"];

/** What a test reads as the system, a model call and a token as trusted code makes them. */
const peek = definePlugin({
  name: "peek",
  collections: {
    peek: defineCollection({
      schema: { type: "object" },
      queries: {
        docs: (_, params: { name: string; filter?: Filter }, ctx) =>
          ctx.db.collection(params.name).find(params.filter ?? {}),
      },
    }),
  },
  actions: {
    "peek.ask": defineAction({
      input: { type: "object" },
      run: (ctx, input: { actor: Actor; model?: unknown }) =>
        ctx.as(input.actor).call("llm.generate", {
          model: input.model ?? PLAN,
          messages: [{ role: "user", text: "hi" }],
          tags: { purpose: "test" },
        }),
    }),
    // A renewal from what was read before another renewal won (as a second process would).
    "peek.renew": defineAction({
      input: { type: "object" },
      run: async (ctx, input: { doc: AccountDoc }) =>
        (await renew(ctx.as(), input.doc, providersOf(ctx).chatgpt)).access,
    }),
    "peek.token": defineAction({
      input: { type: "object" },
      run: (ctx, input: { actor?: Actor; person?: string }) =>
        (input.actor ? ctx.as(input.actor) : ctx).call("account.token", {
          provider: "chatgpt",
          ...(input.person ? { person: input.person } : {}),
        }),
    }),
  },
  views: {
    "peek.accounts": {
      test: (_: unknown, ctx: ViewContext) => ctx.db.collection("account").find({}).value ?? [],
    },
  },
});

type Setup = {
  rt: Awaited<ReturnType<typeof createRuntime>>;
  openai: FakeOpenAI;
  store: Store;
  clock: ReturnType<typeof manualClock>;
};

async function setup(
  options: { key?: string; store?: Store; expiresIn?: number } = {},
): Promise<Setup & { close(): Promise<void> }> {
  const openai = await fakeOpenAI();
  if (options.expiresIn) openai.settings.expiresIn = options.expiresIn;
  const store = options.store ?? memoryStore();
  const clock = manualClock(Date.now());
  const rt = await createRuntime({
    store,
    clock,
    plugins: [
      models,
      usage,
      chat,
      ...access,
      accounts,
      peek,
      definePlugin({
        name: "app",
        resources: {
          ...openai.resources,
          shared: { thread: {}, message: {} },
          accounts: options.key ? { key: options.key } : {},
          agents: { lead: { instructions: "Hi.", model: PLAN, default: true } },
        },
      }),
    ],
  });
  return {
    rt,
    openai,
    store,
    clock,
    close: async () => {
      await rt.close();
      await openai.close();
    },
  };
}

/** Connects someone's ChatGPT: the sign-in address, OpenAI's, then the address it lands on, pasted. */
async function connect({ rt, openai }: Setup, who: Actor): Promise<Account> {
  const started = await rt.call<Connecting>("account.connect", { provider: "chatgpt" }, {
    actor: who,
  });
  const landed = openai.signIn(started.url, who.id);
  return await rt.call<Account>("account.complete", { provider: "chatgpt", address: landed }, {
    actor: who,
  });
}

const docs = <T = Record<string, unknown>>(s: Setup, name: string, filter?: Filter) =>
  s.rt.query<T[]>("peek.docs", { name, filter });

/** Waits for something to hold (a timer's call to finish). */
async function until(what: string, holds: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await holds()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const leaks = (where: unknown, secrets: string[]) => {
  const text = JSON.stringify(where);
  return secrets.filter((secret) => text.includes(secret));
};

test("connecting ChatGPT: a sign-in OpenAI takes, pasted back, and its person's own account", async () => {
  const s = await setup();
  try {
    const started = await s.rt.call<Connecting>("account.connect", { provider: "chatgpt" }, {
      actor: ana,
    });
    const asked = new URL(started.url);
    assertEquals(`${asked.origin}${asked.pathname}`, `${s.openai.url}/oauth/authorize`);
    assertEquals(asked.searchParams.get("redirect_uri"), s.openai.LANDING);
    assertEquals(asked.searchParams.get("scope"), "openid profile email offline_access");
    assertEquals(asked.searchParams.get("code_challenge_method"), "S256");
    assertEquals(started.paste, s.openai.LANDING);
    const landed = s.openai.signIn(started.url, "ana");
    const connected = await s.rt.call<Account>("account.complete", {
      provider: "chatgpt",
      address: `  ${landed}\n`,
    }, { actor: ana });
    assertEquals(
      { ...connected, connected: "", refreshed: "", expires: "" },
      {
        _id: "ana|chatgpt",
        person: "ana",
        provider: "chatgpt",
        status: "connected",
        label: "ana@example.com",
        plan: "Plus",
        connected: "",
        refreshed: "",
        expires: "",
      },
    );
    // What the page reads: the account, as its person sees it.
    const [mine] = await s.rt.observe("test", "peek.accounts", {}, { actor: ana }).ready.then(
      (o) => (o as { value: Account[] }).value,
    );
    assertEquals(mine.label, "ana@example.com");
    assertEquals("tokens" in mine, false);
    // The providers, as the page shows them: nothing of their clients.
    const shown = await s.rt.query<ProviderShown[]>("account.providers", {}, { actor: ana });
    assertEquals(shown.map((p) => [p.name, p.title, p.paste, p.models]), [
      ["chatgpt", "ChatGPT", s.openai.LANDING, ["chatgpt"]],
    ]);
    assertEquals(JSON.stringify(shown).includes("app_EMoamEEZ"), false);
  } finally {
    await s.close();
  }
});

test("agents run on the plan of whom they work for, and on the app's model without one", async () => {
  const s = await setup();
  try {
    await connect(s, ana);
    const say = async (who: Actor, text: string) => {
      const { space } = await s.rt.call<{ space: string }>("space.personal", {}, { actor: who });
      const { thread } = await s.rt.call<{ thread: string }>("chat.send", { text, in: space }, {
        actor: who,
      });
      await s.rt.idle();
      const said = await s.rt.query<Message[]>("message.history", { thread }, { actor: who });
      return said.at(-1)!.text;
    };
    assertEquals(await say(ana, "hello"), "On ana's plan.");
    // Bob has no ChatGPT connected: the next model answers.
    assertEquals(await say(bob, "hello"), "You said: bob: hello");
    assertEquals(s.openai.seen.calls.map((c) => [c.who, c.account]), [["ana", "acct-ana"]]);
    const [call] = s.openai.seen.calls;
    assertEquals([call.body.model, call.body.store, call.body.stream], [
      "gpt-6.1-sol",
      false,
      true,
    ]);

    // Metered all the same: as Ana's plan, at no cost to the app.
    const used = await docs<{ subject: string; tags: Record<string, string>; cost?: number }>(
      s,
      "usage",
      { subject: "chatgpt/gpt-6.1-sol" },
    );
    assertEquals(used.length, 1);
    assertEquals([used[0].tags.paid, used[0].tags.person, used[0].cost], [
      "subscription",
      "ana",
      0,
    ]);

    // Which agents run on whose plan, as the chat shows it.
    assertEquals(
      await s.rt.query("account.uses", { models: { lead: PLAN, other: "fake/echo" } }, {
        actor: ana,
      }),
      { lead: { provider: "chatgpt", title: "ChatGPT", label: "ana@example.com", plan: "Plus" } },
    );
    assertEquals(await s.rt.query("account.uses", { models: { lead: PLAN } }, { actor: bob }), {});
    // A model of the app's first: it's the app's, whatever comes after.
    assertEquals(
      await s.rt.query("account.uses", { models: { lead: ["fake/echo", ...PLAN] } }, {
        actor: ana,
      }),
      {},
    );
  } finally {
    await s.close();
  }
});

test("the token: whom a call is for, and clear codes without one", async () => {
  const s = await setup();
  try {
    await connect(s, ana);
    const anaToken = await s.rt.call<{ token: string; headers: Record<string, string> }>(
      "peek.token",
      { actor: lead(ana) },
    );
    assertEquals(anaToken.headers["chatgpt-account-id"], "acct-ana");
    assertEquals(anaToken.headers.authorization, `Bearer ${anaToken.token}`);
    assert(s.openai.secrets.includes(anaToken.token));
    // The person themself, and the system naming them, get the same.
    assertEquals(
      (await s.rt.call<{ token: string }>("peek.token", { actor: ana })).token,
      anaToken.token,
    );
    assertEquals(
      (await s.rt.call<{ token: string }>("peek.token", { person: "ana" })).token,
      anaToken.token,
    );
    // Without a connection, for nobody, or asking for someone else: refused, by code.
    const code = (input: Record<string, unknown>) =>
      s.rt.call("peek.token", input).then(() => "none", (e) => e.code);
    assertEquals(await code({ actor: lead(bob) }), "account_missing");
    assertEquals(await code({}), "account_missing");
    assertEquals(await code({ actor: { kind: "agent", id: "lead" } }), "account_missing");
    assertEquals(await code({ actor: bob, person: "ana" }), "forbidden");
    // Nobody calls it from outside.
    await assertRejects(
      () => s.rt.call("account.token", { provider: "chatgpt" }, { actor: ana }),
      Error,
      "may not call",
    );
    // A model call for Bob moves on to the next model; with ChatGPT alone it fails, saying why.
    const answer = await s.rt.call<Completion>("peek.ask", { actor: lead(bob) });
    assertEquals(answer.text, "You said: hi");
    const failed = await s.rt.call("peek.ask", { actor: lead(bob), model: "chatgpt/gpt-6.1-sol" })
      .then(() => undefined, (e) => e);
    assertEquals(failed.code, "account_missing");
    assert(failed.message.includes("No ChatGPT account is connected"));
  } finally {
    await s.close();
  }
});

test("a sign-in is its person's own, at its address, and used once", async () => {
  const s = await setup();
  try {
    const started = await s.rt.call<Connecting>("account.connect", { provider: "chatgpt" }, {
      actor: ana,
    });
    const landed = s.openai.signIn(started.url, "ana");
    const complete = (who: Actor, address: string) =>
      s.rt.call("account.complete", { provider: "chatgpt", address }, { actor: who })
        .then(() => "connected", (e) => e.message as string);
    // Bob can't finish Ana's (and trying doesn't spoil it for her).
    assertEquals(
      await complete(bob, landed),
      "This ChatGPT sign-in isn't one you started here: start again",
    );
    assertEquals(await complete(ana, landed), "connected");
    // Once only.
    assertEquals(
      await complete(ana, landed),
      "This ChatGPT sign-in isn't one you started here: start again",
    );
    // Only from where OpenAI sends people.
    const again = await s.rt.call<Connecting>("account.connect", { provider: "chatgpt" }, {
      actor: ana,
    });
    const elsewhere = s.openai.signIn(again.url, "ana").replace(
      "http://localhost:1455",
      "https://example.com",
    );
    assertEquals(
      await complete(ana, elsewhere),
      "That isn't the address ChatGPT sent you to: start again",
    );
    // Starting again leaves the one before nothing to finish.
    const first = await s.rt.call<Connecting>("account.connect", { provider: "chatgpt" }, {
      actor: bob,
    });
    const second = await s.rt.call<Connecting>("account.connect", { provider: "chatgpt" }, {
      actor: bob,
    });
    const stale = s.openai.signIn(first.url, "bob");
    assertEquals(
      await complete(bob, stale),
      "This ChatGPT sign-in isn't one you started here: start again",
    );
    assertEquals(await complete(bob, s.openai.signIn(second.url, "bob")), "connected");
    // Not allowed at OpenAI: nothing connected, said plainly.
    const denied = await s.rt.call<Connecting>("account.connect", { provider: "chatgpt" }, {
      actor: ana,
    });
    const state = new URL(denied.url).searchParams.get("state")!;
    assertEquals(
      await complete(ana, `${s.openai.LANDING}?error=access_denied&state=${state}`),
      "ChatGPT wasn't allowed: nothing was connected",
    );
    // Not an address, or one without a code.
    assertEquals(
      await complete(ana, "the code"),
      "That isn't an address: copy the whole address from the browser's address bar",
    );
    assertEquals(
      await complete(ana, s.openai.LANDING),
      "That address has no sign-in code: copy the address of the page ChatGPT sent you to",
    );
    // A code OpenAI won't take (it was another sign-in's challenge) is refused there.
    const mine = await s.rt.call<Connecting>("account.connect", { provider: "chatgpt" }, {
      actor: ana,
    });
    const other = await s.rt.call<Connecting>("account.connect", { provider: "chatgpt" }, {
      actor: bob,
    });
    const code = new URL(s.openai.signIn(other.url, "bob")).searchParams.get("code")!;
    const myState = new URL(mine.url).searchParams.get("state")!;
    assertEquals(
      await complete(ana, `${s.openai.LANDING}?code=${code}&state=${myState}`),
      "ChatGPT refused it (invalid_grant)",
    );
    assertEquals(
      await s.rt.call("account.connect", { provider: "nobody" }, { actor: ana }).catch((e) =>
        e.message
      ),
      'No account provider "nobody"',
    );
  } finally {
    await s.close();
  }
});

test("tokens are renewed before they run out: on their timer, and as they're used, once at a time", async () => {
  const s = await setup();
  try {
    const before = await connect(s, ana);
    const first = (await s.rt.call<{ token: string }>("peek.token", { actor: lead(ana) })).token;
    // Its timer comes due a fifth of its life (an hour) before it runs out.
    s.clock.advance(47 * 60_000);
    assertEquals(s.openai.seen.grants.filter((g) => g === "refresh_token").length, 0);
    s.clock.advance(2 * 60_000);
    await until("the renewal", () => s.openai.seen.grants.includes("refresh_token"));
    await until(
      "the renewal written",
      async () => (await docs<Account>(s, "account"))[0].refreshed !== before.refreshed,
    );
    const renewed = (await s.rt.call<{ token: string }>("peek.token", { actor: lead(ana) })).token;
    assert(renewed !== first);
    assertEquals(
      await s.rt.call<Completion>("peek.ask", { actor: lead(ana) }).then((c) => c.text),
      "On ana's plan.",
    );
  } finally {
    await s.close();
  }
  // One that runs out within a minute is renewed as it's used, once for those using it together.
  const t = await setup({ expiresIn: 30 });
  try {
    await connect(t, ana);
    const both = await Promise.all([
      t.rt.call<{ token: string }>("peek.token", { actor: lead(ana) }),
      t.rt.call<{ token: string }>("peek.token", { actor: ana }),
    ]);
    assertEquals(both[0].token, both[1].token);
    assertEquals(t.openai.seen.grants, ["authorization_code", "refresh_token"]);
  } finally {
    await t.close();
  }
});

test("an account the provider refuses needs reconnecting; one it can't reach loses nothing", async () => {
  const s = await setup({ expiresIn: 30 });
  try {
    await connect(s, ana);
    s.openai.settings.busy = true;
    const busy = await s.rt.call("peek.token", { actor: lead(ana) }).then(() => "", (e) => e.code);
    assertEquals(busy, "account_unavailable");
    assertEquals((await docs<Account>(s, "account"))[0].status, "connected");
    // Its timer tries again in a while.
    assertEquals(
      await s.rt.call("account.refresh", { account: "ana|chatgpt" }).then((r) =>
        (r as { status: string }).status
      ),
      "connected",
    );
    s.openai.settings.busy = false;
    // OpenAI ends Ana's grant on its side.
    s.openai.revokeAll("ana");
    const refused = await s.rt.call("peek.token", { actor: lead(ana) }).then(
      () => undefined,
      (e) => e,
    );
    assertEquals(refused.code, "account_needs_reconnect");
    const [lost] = await docs<Account & { tokens?: unknown }>(s, "account");
    assertEquals([lost.status, lost.problem, "tokens" in lost], [
      "revoked",
      "This sign-in was ended at the provider. Sign in again to use it.",
      false,
    ]);
    // Her agents move on to the next model, and the chat can say why.
    assertEquals(
      (await s.rt.call<Completion>("peek.ask", { actor: lead(ana) })).text,
      "You said: hi",
    );
    assertEquals(await s.rt.query("account.uses", { models: { lead: PLAN } }, { actor: ana }), {
      lead: { provider: "chatgpt", title: "ChatGPT", reconnect: true },
    });
    // Signing in again connects it again.
    assertEquals((await connect(s, ana)).status, "connected");
    const changes = (await s.store.events(0, 10_000)).filter((e) => e.type === "account.changed");
    assertEquals(changes.map((e) => e.data.status), ["connected", "revoked", "connected"]);
  } finally {
    await s.close();
  }
  // A refresh token already used (renewed by something that kept the new one to itself) only
  // needs signing in again.
  const t = await setup({ expiresIn: 30 });
  try {
    await connect(t, ana);
    const [held] = await docs<{ tokens: { refresh: string } }>(t, "account");
    await fetch(`${t.openai.url}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT,
        refresh_token: held.tokens.refresh,
      }),
    }).then((response) => response.body?.cancel());
    const lapsed = await t.rt.call("peek.token", { actor: ana }).then(() => "", (e) => e.code);
    assertEquals(lapsed, "account_needs_reconnect");
    const [lost] = await docs<Account>(t, "account");
    assertEquals([lost.status, lost.problem], [
      "needs_reconnect",
      "Its sign-in ran out. Sign in again to keep using it.",
    ]);
  } finally {
    await t.close();
  }
});

test("a renewal that lost the race to another keeps the winner's tokens, and the account", async () => {
  const s = await setup({ expiresIn: 30 });
  try {
    await connect(s, ana);
    const [stale] = await docs<AccountDoc>(s, "account");
    // Another renewal wins, using (and so spending) the refresh token.
    const won = (await s.rt.call<{ token: string }>("peek.token", { actor: ana })).token;
    // This one, from what it read before, is refused: the winner's tokens stand.
    assertEquals(await s.rt.call("peek.renew", { doc: stale }), won);
    const [now] = await docs<Account>(s, "account");
    assertEquals(now.status, "connected");
  } finally {
    await s.close();
  }
});

test("disconnecting asks OpenAI to end it, and the account goes with its timer", async () => {
  const s = await setup();
  try {
    await connect(s, ana);
    const { token } = await s.rt.call<{ token: string }>("peek.token", { actor: ana });
    assertEquals(
      await s.rt.call("account.disconnect", { provider: "chatgpt" }, { actor: ana }),
      { disconnected: true },
    );
    assertEquals(s.openai.seen.revoked.length, 2);
    assert(s.openai.seen.revoked.includes(token));
    assertEquals(await docs(s, "account"), []);
    assertEquals(
      await s.rt.call("peek.token", { actor: ana }).then(() => "", (e) => e.code),
      "account_missing",
    );
    // No renewal comes for it.
    s.clock.advance(2 * 3600_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(s.openai.seen.grants.includes("refresh_token"), false);
    assertEquals(
      await s.rt.call("account.disconnect", { provider: "chatgpt" }, { actor: ana }),
      { disconnected: false },
    );
    // Bob can't disconnect Ana's: his own is all he reaches.
    await connect(s, ana);
    assertEquals(
      await s.rt.call("account.disconnect", { provider: "chatgpt" }, { actor: bob }),
      { disconnected: false },
    );
    assertEquals((await docs(s, "account")).length, 1);
  } finally {
    await s.close();
  }
});

const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  ...(env("COPILOTZ_TEST_POSTGRES_URL")
    ? {
      postgres: () =>
        temporary(
          postgresStore({
            url: env("COPILOTZ_TEST_POSTGRES_URL")!,
            schema: `accounts_${crypto.randomUUID().slice(0, 8)}`,
          }),
        ),
    }
    : {}),
};

for (const [name, make] of Object.entries(stores)) {
  test(`${name}: nothing secret leaks: not into events, Views, queries, errors, logs or other people's`, async () => {
    const said: string[] = [];
    const console_ = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      info: console.info,
    };
    for (const level of ["log", "warn", "error", "info"] as const) {
      console[level] = (...args: unknown[]) => void said.push(args.map(String).join(" "));
    }
    const s = await setup({ store: await make(), expiresIn: 30 });
    try {
      const started = await s.rt.call<Connecting>("account.connect", { provider: "chatgpt" }, {
        actor: ana,
      });
      const state = new URL(started.url).searchParams.get("state")!;
      const landed = s.openai.signIn(started.url, "ana");
      await s.rt.call("account.complete", { provider: "chatgpt", address: landed }, { actor: ana });
      // Used, renewed as it's used, refused once revoked, connected again and disconnected.
      await s.rt.call("peek.ask", { actor: lead(ana) });
      s.openai.revokeAll("ana");
      const refused = await s.rt.call("peek.token", { actor: lead(ana) }).then(
        () => undefined,
        (e) => e,
      );
      await connect(s, ana);
      await connect(s, bob);
      const seen = await s.rt.observe("test", "peek.accounts", {}, { actor: ana }).ready;
      const bobs = await s.rt.observe("test", "peek.accounts", {}, { actor: bob }).ready;
      const agents = await s.rt.observe("test", "peek.accounts", {}, { actor: lead(ana) }).ready;
      const providers = await s.rt.query("account.providers", {}, { actor: ana });
      await s.rt.call("account.disconnect", { provider: "chatgpt" }, { actor: ana });
      const events = await s.store.events(0, 100_000);
      const secrets = [...s.openai.secrets, state];
      assert(secrets.length >= 8);
      assertEquals(leaks(events, secrets), []);
      assertEquals(leaks([seen, bobs, agents, providers], secrets), []);
      assertEquals(leaks([refused.message, refused.stack], secrets), []);
      assertEquals(leaks(said, secrets), []);
      // Each person sees their own; an agent, nobody's.
      assertEquals((seen as { value: Account[] }).value.map((a) => a.person), ["ana"]);
      assertEquals((bobs as { value: Account[] }).value.map((a) => a.person), ["bob"]);
      assertEquals((agents as { value: Account[] }).value, []);
      // The audit trail is there, as who did it.
      const changes = events.filter((e) => e.type === "account.changed");
      assertEquals(
        changes.map((e) => [e.data.person, e.data.status, e.actor?.id ?? "system"]),
        [
          ["ana", "connected", "ana"],
          ["ana", "revoked", "system"],
          ["ana", "connected", "ana"],
          ["bob", "connected", "bob"],
          ["ana", "disconnected", "ana"],
        ],
      );
      // Account documents record no lifecycle events at all.
      assertEquals(
        events.filter((e) => e.type.startsWith("account.") && e.type !== "account.changed").length,
        0,
      );
    } finally {
      Object.assign(console, console_);
      await s.close();
    }
  });
}

test("with the app's key, tokens are sealed at rest, to their own account", async () => {
  const s = await setup({ key: "a long secret of the app's own, kept elsewhere" });
  try {
    await connect(s, ana);
    await connect(s, bob);
    const kept = await docs<{ _id: string; tokens: unknown }>(s, "account");
    for (const doc of kept) {
      assertEquals(typeof doc.tokens, "string");
      assert((doc.tokens as string).startsWith("v1."));
    }
    assertEquals(leaks(kept, s.openai.secrets), []);
    // Still works, opened as it's used.
    assertEquals(
      (await s.rt.call<Completion>("peek.ask", { actor: lead(ana) })).text,
      "On ana's plan.",
    );
    // Ana's sealed tokens moved onto Bob's account don't open there.
    const { seal, unseal } = await import("../accounts/shared/seal.ts");
    const sealed = await seal("k", "ana|chatgpt", { access: "a", account: "x" });
    assertEquals((await unseal("k", "ana|chatgpt", sealed)).access, "a");
    await assertRejects(() => unseal("k", "bob|chatgpt", sealed), Error, "can't be opened");
    await assertRejects(() => unseal("another", "ana|chatgpt", sealed), Error, "can't be opened");
    await assertRejects(() => unseal(undefined, "ana|chatgpt", sealed), Error, "no key");
  } finally {
    await s.close();
  }
});

test("a provider declared wrong stops the runtime from starting", async () => {
  const start = (provider: Record<string, unknown>) =>
    createRuntime({
      store: memoryStore(),
      plugins: [
        ...access,
        accounts,
        definePlugin({ name: "app", resources: { accountProviders: { mine: provider } } }),
      ],
    }).then((rt) => rt.close());
  const fine = {
    title: "Mine",
    allows: "It lets agents in.",
    oauth: { authorize: "https://x.example/a", token: "https://x.example/t", clientId: "c" },
    profile: () => ({ id: "1", label: "me" }),
  };
  await start(fine);
  await assertRejects(
    () => start({ ...fine, oauth: { ...fine.oauth, token: "http://x.example/t" } }),
    Error,
    "oauth.token must be an https address",
  );
  await assertRejects(
    () => start({ ...fine, oauth: { ...fine.oauth, clientId: "" } }),
    Error,
    "needs oauth.clientId",
  );
  await assertRejects(() => start({ ...fine, profile: undefined }), Error, "needs a profile");
});
