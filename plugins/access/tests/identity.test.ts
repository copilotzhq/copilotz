/**
 * Identity: keys and sessions prove someone (hashed at rest, revoked by
 * deleting them); Google sign-in turns a verified ID token into a person and
 * a session, and refuses anything else.
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

async function start(): Promise<Runtime> {
  return await createRuntime({
    store: memoryStore(),
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

test("a key proves its person until it's revoked; others don't see it", async () => {
  const rt = await start();
  try {
    const { key } = await rt.call<{ key: string }>("key.create", { name: "ci" }, { actor: ana });
    assert(key.startsWith("key_"));
    const actor = await rt.query<Actor>("credential.actor", { secret: key });
    assertEquals([actor.kind, actor.id, typeof actor.key], ["person", "ana", "string"]);
    // A key can't make keys.
    await assertRejects(() => rt.call("key.create", { name: "more" }, { actor }), Error, "may not");
    // Ana sees her key's name, not its secret; Bob sees none of hers.
    const mine = await rt.query<{ name: string }[]>("credential.keys", { person: "ana" }, {
      actor: ana,
    });
    assertEquals(mine.map((k) => k.name), ["ci"]);
    assert(!JSON.stringify(mine).includes(key));
    assertEquals(await rt.query("credential.keys", { person: "ana" }, { actor: bob }), []);
    // Revoked, it proves nobody.
    assertEquals(await rt.call("key.revoke", { name: "ci" }, { actor: bob }), { revoked: 0 });
    assertEquals(await rt.call("key.revoke", { name: "ci" }, { actor: ana }), { revoked: 1 });
    assertEquals(await rt.query("credential.actor", { secret: key }), null);
    assertEquals(await rt.query("credential.actor", { secret: "key_nonsense" }), null);
  } finally {
    await rt.close();
  }
});

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
    await rt.call("session.end", { session }, { actor: ana });
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

test("a session's or a key's secret never lands in the log", async () => {
  const store = memoryStore();
  const rt = await createRuntime({ store, plugins: [...access] });
  try {
    const { session } = await rt.call<{ session: string }>("session.start", { person: "ana" });
    const ana = (await rt.query("credential.actor", { secret: session })) as Actor;
    const { key } = await rt.call<{ key: string }>("key.create", { name: "ci" }, { actor: ana });
    const logged = JSON.stringify(await store.events(0, 1000));
    assertEquals([logged.includes(session), logged.includes(key)], [false, false]);
  } finally {
    await rt.close();
  }
});
