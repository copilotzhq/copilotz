/**
 * Identity: keys and sessions prove someone (hashed at rest, revoked by
 * deleting them); Google sign-in turns a verified ID token into a person and
 * a session, and refuses anything else. No secret, nor Google's token, is
 * ever in the log.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { type Actor, createRuntime, definePlugin, type Runtime } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { access, googleSignIn, type Jwk } from "../mod.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };

/** A key pair standing in for Google's, and tokens signed with it. */
const google = await (async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "k1" } as Jwk;
  const b64 = (data: Uint8Array | string) =>
    btoa(typeof data === "string" ? data : String.fromCharCode(...data))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const sign = async (claims: Record<string, unknown>, kid = "k1") => {
    const head = b64(JSON.stringify({ alg: "RS256", kid }));
    const body = b64(JSON.stringify(claims));
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(`${head}.${body}`),
    );
    return `${head}.${body}.${b64(new Uint8Array(signature))}`;
  };
  const claims = (more: Record<string, unknown> = {}) => ({
    iss: "https://accounts.google.com",
    aud: "my-app",
    sub: "123",
    exp: Math.floor(Date.now() / 1000) + 600,
    email: "ana@example.com",
    email_verified: true,
    name: "Ana",
    ...more,
  });
  return { jwk, sign, claims };
})();

async function start(store = memoryStore()): Promise<Runtime> {
  return await createRuntime({
    store,
    plugins: [
      ...access,
      googleSignIn,
      definePlugin({ name: "app", resources: { google: { clientId: "my-app" } } }),
      // Google's keys, here: no network.
      definePlugin({
        name: "keys",
        adapters: { googleKeys: { google: { keys: () => Promise.resolve([google.jwk]) } } },
      }),
    ],
  });
}

test("a session proves its person until it ends or expires", async () => {
  const rt = await start();
  try {
    const { session } = await rt.call<{ session: string }>("session.start", { person: "ana" });
    assertEquals(await rt.query("credential.actor", { secret: session }), {
      kind: "person",
      id: "ana",
    });
    // Only the system starts sessions: a person can't make one for anyone.
    await assertRejects(() => rt.call("session.start", { person: "bob" }, { actor: ana }));
    await rt.call("session.end", { secret: session }, { actor: ana });
    assertEquals(await rt.query("credential.actor", { secret: session }), null);
    const old = await rt.call<{ session: string }>("session.start", { person: "ana", ms: -1 });
    assertEquals(await rt.query("credential.actor", { secret: old.session }), null);
  } finally {
    await rt.close();
  }
});

test("Google sign-in: a verified token makes a person and a session, once", async () => {
  const rt = await start();
  try {
    const first = await rt.call<{ person: string; session: string; new: boolean }>(
      "google.sign-in",
      { idToken: await google.sign(google.claims()) },
    );
    assertEquals([first.person, first.new], ["google:123", true]);
    assertEquals(await rt.query("credential.actor", { secret: first.session }), {
      kind: "person",
      id: "google:123",
    });
    const again = await rt.call<{ person: string; new: boolean }>("google.sign-in", {
      idToken: await google.sign(google.claims({ name: "Ana B." })),
    });
    assertEquals([again.person, again.new], ["google:123", false]);
  } finally {
    await rt.close();
  }
});

test("Google sign-in refuses tokens for another app, expired, unverified, forged", async () => {
  const rt = await start();
  try {
    const refused = async (idToken: string, why: string) =>
      void await assertRejects(() => rt.call("google.sign-in", { idToken }), Error, why);
    await refused(await google.sign(google.claims({ aud: "their-app" })), "another app");
    await refused(await google.sign(google.claims({ exp: 1 })), "expired");
    await refused(await google.sign(google.claims({ email_verified: false })), "isn't verified");
    await refused(await google.sign(google.claims({ iss: "evil.example" })), "not issued");
    await refused(await google.sign(google.claims(), "k2"), "unknown key");
    const token = await google.sign(google.claims());
    const [head, , signature] = token.split(".");
    const forged = btoa(JSON.stringify(google.claims({ sub: "999" })))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await refused(`${head}.${forged}.${signature}`, "bad signature");
    assertEquals(await rt.query("credential.actor", { secret: "nothing" }), null);
  } finally {
    await rt.close();
  }
});

test("a session's secret never lands in the log", async () => {
  const store = memoryStore();
  const rt = await createRuntime({ store, plugins: [...access] });
  try {
    const { session } = await rt.call<{ session: string }>("session.start", { person: "ana" });
    const ana = (await rt.query("credential.actor", { secret: session })) as Actor;
    // Ending a session shows its secret too.
    await rt.call("session.end", { secret: session }, { actor: ana });
    await rt.idle();
    const logged = JSON.stringify(await store.events(0, 1000));
    assertEquals(logged.includes(session), false);
  } finally {
    await rt.close();
  }
});

test("keys are the api plugin's alone, each with a scope: identity makes none", async () => {
  const rt = await start();
  try {
    const actions = Object.keys(rt.describe().actions);
    assertEquals(actions.filter((name) => name.startsWith("key.")), []);
  } finally {
    await rt.close();
  }
});

test("a Google sign-in leaves neither its ID token nor the session's secret in the log", async () => {
  const store = memoryStore();
  const rt = await start(store);
  try {
    const idToken = await google.sign(google.claims());
    const { person, session } = await rt.call<{ person: string; session: string }>(
      "google.sign-in",
      { idToken },
    );
    // Signed in for real: the session proves them, and the person was written.
    assertEquals(await rt.query("credential.actor", { secret: session }), {
      kind: "person",
      id: person,
    });
    const again = await rt.call<{ session: string }>("google.sign-in", {
      idToken: await google.sign(google.claims({ name: "Ana B." })),
    });
    await rt.idle();
    const events = await store.events(0, 10_000);
    assert(events.some((e) => e.type === "person.created" || e.type === "person.updated"));
    const logged = JSON.stringify(events);
    const [, payload, signature] = idToken.split(".");
    assertEquals(
      [idToken, payload, signature, session, again.session].map((s) => logged.includes(s)),
      [false, false, false, false, false],
    );
  } finally {
    await rt.close();
  }
});

/** What a person's own record says of their name, and what everyone sees of them (`profile`). */
async function namesOf(rt: Runtime, person: string) {
  await rt.idle();
  const own = await rt.query<{ name?: string; email?: string } | null>("person.profile", {
    person,
  });
  const seen = await rt.query<Record<string, string>>("profile.names", { ids: [person] }, {
    actor: { kind: "person", id: person },
  });
  return { own: own?.name, seen: seen[person] };
}

test("a person names themselves: one line, trimmed, at most 80; empty, they have none", async () => {
  const rt = await start();
  try {
    await rt.call("person.set", { person: "ana", email: "ana@example.com" });
    // Email sign-ups have no name: everyone sees her email's name.
    assertEquals(await namesOf(rt, "ana"), { own: undefined, seen: "ana" });
    assertEquals(
      await rt.call("person.rename", { name: "  Ana \n\t Lima  " }, { actor: ana }),
      { name: "Ana Lima" },
    );
    assertEquals(await namesOf(rt, "ana"), { own: "Ana Lima", seen: "Ana Lima" });
    // At most 80 characters, said plainly.
    const long = await assertRejects(() =>
      rt.call("person.rename", { name: "a".repeat(81) }, { actor: ana })
    ) as Error & { code?: string; public?: boolean };
    assertEquals([long.code, long.message, long.public], [
      "invalid",
      "A name is at most 80 characters.",
      true,
    ]);
    assertEquals((await namesOf(rt, "ana")).own, "Ana Lima");
    const longest = "Ana ".repeat(20).trim() + "s";
    assertEquals(longest.length, 80);
    assertEquals(await rt.call("person.rename", { name: longest }, { actor: ana }), {
      name: longest,
    });
    // Empty (or only spaces), she has none: everyone sees her email's name again.
    assertEquals(await rt.call("person.rename", { name: "   " }, { actor: ana }), { name: null });
    assertEquals(await namesOf(rt, "ana"), { own: undefined, seen: "ana" });
    assertEquals(await rt.query("person.profile", { person: "ana" }), {
      email: "ana@example.com",
    });
  } finally {
    await rt.close();
  }
});

test("only a person names themselves, and only themselves: never a contact, key, agent or routine", async () => {
  const rt = await start();
  try {
    await rt.call("person.set", { person: "bob", email: "bob@example.com", name: "Bob" });
    // There's no one else to name: who is named is who calls.
    await assertRejects(() =>
      rt.call("person.rename", { name: "Not Bob", person: "bob" }, { actor: ana })
    );
    assertEquals((await namesOf(rt, "bob")).own, "Bob");
    const refused: Actor[] = [
      { kind: "contact", id: "c1" },
      // A developer key acting as Bob.
      { kind: "person", id: "bob", key: "k1" },
      // An agent working for Bob.
      { kind: "agent", id: "north", for: bob },
      // A routine Bob set going.
      { kind: "person", id: "bob", origin: { kind: "routine", id: "r1" } },
    ];
    for (const actor of refused) {
      const error = await assertRejects(() =>
        rt.call("person.rename", { name: "Robert" }, { actor })
      ) as { code?: string };
      assertEquals(error.code, "forbidden", actor.kind);
    }
    assertEquals((await namesOf(rt, "bob")).own, "Bob");
    // Bob himself, in person.
    await rt.call("person.rename", { name: "Robert" }, { actor: bob });
    assertEquals((await namesOf(rt, "bob")).own, "Robert");
    // From outside, the record itself is still written only through its Actions.
    await assertRejects(() =>
      rt.call("person.set", { person: "bob", name: "Bobby" }, { actor: bob })
    );
  } finally {
    await rt.close();
  }
});

test("a name someone chose stays through sign-ins, as does having none; until then, they keep it current", async () => {
  const rt = await start();
  try {
    const signIn = async (name: string) =>
      (await rt.call<{ person: string }>("google.sign-in", {
        idToken: await google.sign(google.claims({ name })),
      })).person;
    const person = await signIn("Ana");
    const her: Actor = { kind: "person", id: person };
    // Not chosen yet: Google's name follows Google.
    await signIn("Ana B.");
    assertEquals((await namesOf(rt, person)).own, "Ana B.");
    // Chosen: neither Google's sign-in nor the system's `person.set` changes it.
    await rt.call("person.rename", { name: "Aninha" }, { actor: her });
    await signIn("Ana C.");
    await rt.call("person.set", { person, name: "Ana D." });
    assertEquals((await namesOf(rt, person)).own, "Aninha");
    // Cleared: she has none, sign-ins or not.
    await rt.call("person.rename", { name: "" }, { actor: her });
    await signIn("Ana E.");
    await rt.call("person.set", { person, name: "Ana F.", email: "ana@example.com" });
    assertEquals(await namesOf(rt, person), { own: undefined, seen: "ana" });
  } finally {
    await rt.close();
  }
});
