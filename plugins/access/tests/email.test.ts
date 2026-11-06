/**
 * Email sign-in, through its routes as the page uses them, with Resend
 * faked (`createRuntime({ fetch })`): making an account with a code, signing
 * in (refused until the address is confirmed, a new code sent), a new
 * password by a code, invitations by link from trusted code, and people
 * moving in with the hashes another app kept (an app moving from Copilotz 0.x, verified exactly
 * as stored, made stronger at their first sign-in). Every refusal says the
 * same for an address nobody has; codes are spent by wrong tries and time;
 * a stranger can't choose someone's password by signing up first; messages,
 * tries and callers are limited. No password, hash, code, token or session
 * is ever in the log, and no actor reads the plugin's records.
 */
import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  type Plugin,
  type Runtime,
  setClientAddress,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { access, email, emailSignIn, hashPassword, verifyPassword } from "../mod.ts";
import { test } from "../../../testing/mod.ts";

const LINKS = { origin: "https://app.example.com", secret: "the-app-secret-for-tests-0123456789" };
const KEY = "re_test_key";

/** A message Resend was asked to send, as its API took it. */
type Sent = {
  url: string;
  authorization: string | null;
  body: { from: string; to: string[]; subject: string; text: string; html?: string };
};

/** Resend, faked: what it was asked to send, kept; `failing` answers 500. */
function fakeResend() {
  const sent: Sent[] = [];
  const state = { failing: false };
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    return request.text().then((text) => {
      if (state.failing) return Response.json({ message: "down" }, { status: 500 });
      sent.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        body: JSON.parse(text),
      });
      return Response.json({ id: `msg_${sent.length}` });
    });
  };
  return { sent, state, fetch: fetch as typeof globalThis.fetch };
}

/** Test-only: every code and link waiting is past its time. */
const expire = definePlugin({
  name: "expire",
  actions: {
    "t.expire": defineAction({
      input: { type: "object" },
      run: async (ctx) => {
        await ctx.db.collection("email_code").updateMany({}, {
          $set: { expires: "2000-01-01T00:00:00.000Z" },
        });
      },
    }),
    // What an actor's own work reads of the plugin's records: nothing.
    "t.peek": defineAction({
      input: { type: "object" },
      allow: () => true,
      run: async (ctx) => ({
        logins: await ctx.db.collection("email_login").countDocuments({}),
        codes: await ctx.db.collection("email_code").countDocuments({}),
      }),
    }),
  },
});

type Start = {
  settings?: Record<string, unknown>;
  links?: typeof LINKS & { previous?: string };
  store?: ReturnType<typeof memoryStore>;
  more?: Plugin[];
};

async function start(options: Start = {}) {
  const resend = fakeResend();
  const rt = await createRuntime({
    store: options.store ?? memoryStore(),
    plugins: [
      ...access,
      email,
      emailSignIn,
      expire,
      definePlugin({
        name: "app",
        resources: {
          links: options.links ?? LINKS,
          email: { adapter: "resend", from: "App <noreply@app.example.com>", apiKey: KEY },
          ...(options.settings ? { emailSignIn: options.settings } : {}),
        },
      }),
      ...options.more ?? [],
    ],
    fetch: resend.fetch,
  });
  return { rt, resend };
}

/** A page's request to the app, from a caller's address (203.0.113.7 unless said). */
const post = (rt: Runtime, path: string, body: unknown, from = "203.0.113.7") =>
  rt.fetch(setClientAddress(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    from,
  ));

/** A response, read: its status, what it said, and the cookie it set (as a browser sends it back). */
async function read(response: Response) {
  return {
    status: response.status,
    said: await response.json() as Record<string, string>,
    cookie: response.headers.get("set-cookie")?.split(";")[0],
    retry: response.headers.get("retry-after"),
  };
}

const ask = async (rt: Runtime, path: string, body: unknown, from?: string) =>
  await read(await post(rt, path, body, from));

/** The last code sent to an address, and the message it came in. */
function codeTo(sent: Sent[], to: string) {
  const message = sent.findLast((m) => m.body.to[0] === to);
  const code = message && /\b(\d{6})\b/.exec(message.body.text)?.[1];
  if (!message || !code) throw new Error(`no code sent to ${to}`);
  return { code, message };
}

/** Who a session cookie proves. */
const whoIs = (rt: Runtime, cookie: string) =>
  rt.query<Actor | null>("credential.actor", { secret: cookie.slice(cookie.indexOf("=") + 1) });

/** Signs up and confirms an address: its person and session cookie. */
async function signUp(rt: Runtime, sent: Sent[], address: string, password: string, name?: string) {
  const asked = await ask(rt, "/signin/email/sign-up", { email: address, password, name });
  assertEquals(asked.status, 200);
  const verified = await ask(rt, "/signin/email/verify", {
    email: address,
    code: codeTo(sent, address).code,
  });
  assertEquals(verified.status, 200);
  return { person: verified.said.person, cookie: verified.cookie! };
}

test("sign up, confirm with the code, sign in and out: a person with their email and name", async () => {
  const { rt, resend } = await start();
  try {
    assertEquals(await (await rt.fetch(new Request("http://localhost/signin/email"))).json(), {
      signUp: true,
    });
    // The address as typed, kept lowercased; nobody is made until it's confirmed.
    const asked = await ask(rt, "/signin/email/sign-up", {
      email: "  Ana@Example.com ",
      password: "correct horse",
      name: "Ana",
    });
    assertEquals([asked.status, asked.said, asked.cookie], [
      200,
      { email: "ana@example.com" },
      undefined,
    ]);
    const { code, message } = codeTo(resend.sent, "ana@example.com");
    assertEquals(message.body.subject, `${code} is your code for app.example.com`);
    assert(message.body.html?.includes(code));
    assertEquals(await rt.query("person.profile", { person: "nobody" }), null);

    const verified = await ask(rt, "/signin/email/verify", {
      email: "ana@example.com",
      code: ` ${code.slice(0, 3)} ${code.slice(3)}`,
    });
    assertEquals(verified.status, 200);
    const person = verified.said.person;
    assertMatch(person, /^email:/);
    assertEquals(await whoIs(rt, verified.cookie!), { kind: "person", id: person });
    assertEquals(await rt.query("person.profile", { person }), {
      name: "Ana",
      email: "ana@example.com",
    });
    // The page asks who it shows.
    const me = await rt.fetch(
      new Request("http://localhost/me", { headers: { cookie: verified.cookie! } }),
    );
    assertEquals(await me.json(), { person, name: "Ana", email: "ana@example.com" });

    // The code is spent: used once.
    const again = await ask(rt, "/signin/email/verify", { email: "ana@example.com", code });
    assertEquals([again.status, again.said.code], [400, "invalid"]);

    const signedIn = await ask(rt, "/signin/email", {
      email: "ANA@example.com",
      password: "correct horse",
    });
    assertEquals([signedIn.status, signedIn.said], [200, { person }]);
    assertEquals(await whoIs(rt, signedIn.cookie!), { kind: "person", id: person });

    const out = await rt.fetch(setClientAddress(
      new Request("http://localhost/signout", {
        method: "POST",
        headers: { cookie: signedIn.cookie! },
      }),
      "203.0.113.7",
    ));
    assertEquals(out.status, 200);
    assertEquals(await whoIs(rt, signedIn.cookie!), null);
  } finally {
    await rt.close();
  }
});

test("a wrong code confirms nothing; five wrong tries spend it, and so does time", async () => {
  const { rt, resend } = await start();
  try {
    await ask(rt, "/signin/email/sign-up", { email: "ana@example.com", password: "correct horse" });
    const { code } = codeTo(resend.sent, "ana@example.com");
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    for (let i = 0; i < 5; i++) {
      const tried = await ask(rt, "/signin/email/verify", {
        email: "ana@example.com",
        code: wrong,
      });
      assertEquals([tried.status, tried.said.code], [400, "invalid"]);
    }
    const spent = await ask(rt, "/signin/email/verify", { email: "ana@example.com", code });
    assertEquals([spent.status, spent.said.code], [400, "invalid"]);

    // Signing in with its password sends a new one, which works until its time is up.
    const unverified = await ask(rt, "/signin/email", {
      email: "ana@example.com",
      password: "correct horse",
    });
    assertEquals([unverified.status, unverified.said.code], [403, "unverified"]);
    await rt.call("t.expire", {});
    const late = await ask(rt, "/signin/email/verify", {
      email: "ana@example.com",
      code: codeTo(resend.sent, "ana@example.com").code,
    });
    assertEquals([late.status, late.said.code], [400, "invalid"]);
    // A code that isn't six digits is wrong like any other.
    const garbled = await ask(rt, "/signin/email/verify", {
      email: "ana@example.com",
      code: "12ab",
    });
    assertEquals([garbled.status, garbled.said.code], [400, "invalid"]);
  } finally {
    await rt.close();
  }
});

test("signing in before confirming is refused with unverified, and a new code goes", async () => {
  const { rt, resend } = await start();
  try {
    await ask(rt, "/signin/email/sign-up", {
      email: "ana@example.com",
      password: "correct horse",
      name: "Ana",
    });
    const first = codeTo(resend.sent, "ana@example.com").code;
    const refused = await ask(rt, "/signin/email", {
      email: "ana@example.com",
      password: "correct horse",
    });
    assertEquals([refused.status, refused.said.code, refused.cookie], [
      403,
      "unverified",
      undefined,
    ]);
    assertEquals(resend.sent.length, 2);
    const second = codeTo(resend.sent, "ana@example.com").code;
    // The new code replaces the first (unless they're the same by chance).
    if (second !== first) {
      const old = await ask(rt, "/signin/email/verify", { email: "ana@example.com", code: first });
      assertEquals(old.status, 400);
    }
    // Another password is just wrong: no code goes for it.
    const wrong = await ask(rt, "/signin/email", {
      email: "ana@example.com",
      password: "battery staple",
    });
    assertEquals([wrong.status, wrong.said.code], [401, "unauthorized"]);
    assertEquals(resend.sent.length, 2);

    const verified = await ask(rt, "/signin/email/verify", {
      email: "ana@example.com",
      code: second,
    });
    assertEquals(verified.status, 200);
    assertEquals(
      (await rt.query<{ name?: string }>("person.profile", { person: verified.said.person }))?.name,
      "Ana",
    );
  } finally {
    await rt.close();
  }
});

test("a stranger signing up with someone's address first can't choose their password", async () => {
  const { rt, resend } = await start();
  try {
    await ask(rt, "/signin/email/sign-up", {
      email: "ana@example.com",
      password: "stranger's pick",
    }, "198.51.100.9");
    await ask(rt, "/signin/email/sign-up", {
      email: "ana@example.com",
      password: "ana's own pick",
    });
    // Ana confirms with the code that came with her own sign-up: hers is the password.
    const verified = await ask(rt, "/signin/email/verify", {
      email: "ana@example.com",
      code: codeTo(resend.sent, "ana@example.com").code,
    });
    assertEquals(verified.status, 200);
    const theirs = await ask(rt, "/signin/email", {
      email: "ana@example.com",
      password: "stranger's pick",
    }, "198.51.100.9");
    assertEquals(theirs.status, 401);
    const hers = await ask(rt, "/signin/email", {
      email: "ana@example.com",
      password: "ana's own pick",
    });
    assertEquals(hers.status, 200);
  } finally {
    await rt.close();
  }
});

test("signing up with an address that has an account sends a word, not a code, and answers the same", async () => {
  const { rt, resend } = await start();
  try {
    await signUp(rt, resend.sent, "ana@example.com", "correct horse");
    const before = resend.sent.length;
    const again = await ask(rt, "/signin/email/sign-up", {
      email: "ana@example.com",
      password: "a new password",
    });
    const fresh = await ask(rt, "/signin/email/sign-up", {
      email: "bob@example.com",
      password: "a new password",
    });
    assertEquals([again.status, again.said], [200, { email: "ana@example.com" }]);
    assertEquals([fresh.status, Object.keys(fresh.said)], [200, ["email"]]);
    const word = resend.sent[before];
    assertEquals(word.body.subject, "You already have an account at app.example.com");
    assertEquals(/\b\d{6}\b/.test(word.body.text), false);
    // Her password is as it was.
    assertEquals(
      (await ask(rt, "/signin/email", { email: "ana@example.com", password: "a new password" }))
        .status,
      401,
    );
    assertEquals(
      (await ask(rt, "/signin/email", { email: "ana@example.com", password: "correct horse" }))
        .status,
      200,
    );
  } finally {
    await rt.close();
  }
});

test("a wrong password and an address nobody has are one refusal", async () => {
  const { rt, resend } = await start();
  try {
    await signUp(rt, resend.sent, "ana@example.com", "correct horse");
    const wrong = await ask(rt, "/signin/email", {
      email: "ana@example.com",
      password: "battery staple",
    });
    const nobody = await ask(rt, "/signin/email", {
      email: "nobody@example.com",
      password: "battery staple",
    });
    assertEquals(wrong, { ...nobody });
    assertEquals([wrong.status, wrong.said.code], [401, "unauthorized"]);
    const bad = await ask(rt, "/signin/email", { email: "not an address", password: "x" });
    assertEquals([bad.status, bad.said.code], [400, "invalid"]);
    const short = await ask(rt, "/signin/email/sign-up", {
      email: "bob@example.com",
      password: "short",
    });
    assertEquals([short.status, short.said.code], [400, "invalid"]);
    assertMatch(short.said.error, /at least 8 characters/);
    const notJson = await rt.fetch(setClientAddress(
      new Request("http://localhost/signin/email", { method: "POST", body: "nope" }),
      "203.0.113.7",
    ));
    assertEquals(notJson.status, 400);
    const get = await rt.fetch(new Request("http://localhost/signin/email/verify"));
    assertEquals(get.status, 405);
  } finally {
    await rt.close();
  }
});

test("forgot answers the same for anyone; reset with its code sets the password and ends other sessions", async () => {
  const { rt, resend } = await start();
  try {
    const { person, cookie } = await signUp(rt, resend.sent, "ana@example.com", "correct horse");
    const before = resend.sent.length;
    const nobody = await ask(rt, "/signin/email/forgot", { email: "nobody@example.com" });
    assertEquals([nobody.status, resend.sent.length], [200, before]);
    const ana = await ask(rt, "/signin/email/forgot", { email: "ana@example.com" });
    assertEquals([ana.status, Object.keys(ana.said)], [nobody.status, Object.keys(nobody.said)]);
    const { code, message } = codeTo(resend.sent, "ana@example.com");
    assertMatch(message.body.subject, /reset your password/);

    const wrong = await ask(rt, "/signin/email/reset", {
      email: "ana@example.com",
      code: "000000" === code ? "111111" : "000000",
      password: "a new password",
    });
    assertEquals([wrong.status, wrong.said.code], [400, "invalid"]);
    const short = await ask(rt, "/signin/email/reset", {
      email: "ana@example.com",
      code,
      password: "short",
    });
    assertEquals(short.status, 400);
    const reset = await ask(rt, "/signin/email/reset", {
      email: "ana@example.com",
      code,
      password: "a new password",
    });
    assertEquals([reset.status, reset.said.person], [200, person]);
    assertEquals(await whoIs(rt, reset.cookie!), { kind: "person", id: person });
    // Signed in before elsewhere: out now.
    assertEquals(await whoIs(rt, cookie), null);
    assertEquals(
      (await ask(rt, "/signin/email", { email: "ana@example.com", password: "correct horse" }))
        .status,
      401,
    );
    assertEquals(
      (await ask(rt, "/signin/email", { email: "ana@example.com", password: "a new password" }))
        .status,
      200,
    );
    // The code is spent.
    assertEquals(
      (await ask(rt, "/signin/email/reset", {
        email: "ana@example.com",
        code,
        password: "another one",
      })).status,
      400,
    );
  } finally {
    await rt.close();
  }
});

test("someone a Google sign-in verified gets a password by a reset, as the same person", async () => {
  const { rt, resend } = await start();
  try {
    await rt.call("person.set", { person: "google:123", email: "ana@example.com", name: "Ana" });
    await ask(rt, "/signin/email/forgot", { email: "ana@example.com" });
    const reset = await ask(rt, "/signin/email/reset", {
      email: "ana@example.com",
      code: codeTo(resend.sent, "ana@example.com").code,
      password: "correct horse",
    });
    assertEquals([reset.status, reset.said.person], [200, "google:123"]);
    // Signing up confirms into them too.
    await rt.call("person.set", { person: "google:456", email: "bob@example.com" });
    const bob = await signUp(rt, resend.sent, "bob@example.com", "correct horse", "Bob");
    assertEquals(bob.person, "google:456");
  } finally {
    await rt.close();
  }
});

test("an invitation: trusted code gets the person at once, and a link that works once, for a day", async () => {
  const { rt, resend } = await start();
  try {
    // Not anyone's to call from outside.
    await assertRejects(() =>
      rt.call("email.invite", { email: "ana@example.com" }, { actor: { kind: "person", id: "x" } })
    );
    const invited = await rt.call<{ person: string; new: boolean; sent: boolean }>("email.invite", {
      email: "Ana@Example.com",
      name: "Ana",
      person: "01HZEXAMPLE1",
    });
    assertEquals(invited, { person: "01HZEXAMPLE1", new: true, sent: true });
    const message = resend.sent.at(-1)!;
    assertEquals(message.body.subject, "Set your password for app.example.com");
    const token = /#email-invite=([A-Za-z0-9_-]+)/.exec(message.body.text)![1];
    assert(message.body.text.includes(`https://app.example.com/#email-invite=${token}`));
    assert(message.body.html?.includes(`href="https://app.example.com/#email-invite=${token}"`));
    // Who it is shows at once: their email, their name.
    assertEquals(await rt.query("person.profile", { person: "01HZEXAMPLE1" }), {
      name: "Ana",
      email: "ana@example.com",
    });
    // Without a password, nobody signs in as them.
    assertEquals(
      (await ask(rt, "/signin/email", { email: "ana@example.com", password: "anything goes" }))
        .status,
      401,
    );

    const shown = await ask(rt, "/signin/email/invitation", { token });
    assertEquals([shown.status, shown.said], [200, { email: "ana@example.com" }]);
    const short = await ask(rt, "/signin/email/accept", { token, password: "short" });
    assertEquals(short.status, 400);
    const accepted = await ask(rt, "/signin/email/accept", { token, password: "correct horse" });
    assertEquals([accepted.status, accepted.said.person], [200, "01HZEXAMPLE1"]);
    assertEquals(await whoIs(rt, accepted.cookie!), { kind: "person", id: "01HZEXAMPLE1" });
    // Used once.
    const again = await ask(rt, "/signin/email/accept", { token, password: "correct horse" });
    assertEquals([again.status, again.said.code], [400, "invalid"]);
    assertMatch(again.said.error, /expired or has been used/);
    assertEquals(
      (await ask(rt, "/signin/email", { email: "ana@example.com", password: "correct horse" })).said
        .person,
      "01HZEXAMPLE1",
    );
    // Invited again with a password: the same person, nothing sent.
    const sent = resend.sent.length;
    assertEquals(await rt.call("email.invite", { email: "ana@example.com" }), {
      person: "01HZEXAMPLE1",
      new: false,
      sent: false,
    });
    assertEquals(resend.sent.length, sent);

    // A link a day old works no more; one never sent never did.
    await rt.call("email.invite", { email: "bob@example.com" });
    const late = /#email-invite=([A-Za-z0-9_-]+)/.exec(resend.sent.at(-1)!.body.text)![1];
    await rt.call("t.expire", {});
    assertEquals((await ask(rt, "/signin/email/invitation", { token: late })).status, 400);
    assertEquals(
      (await ask(rt, "/signin/email/accept", { token: late, password: "correct horse" })).status,
      400,
    );
    assertEquals(
      (await ask(rt, "/signin/email/accept", { token: "x".repeat(43), password: "correct horse" }))
        .status,
      400,
    );
  } finally {
    await rt.close();
  }
});

test("someone invited who signs up or resets instead is the same person", async () => {
  const { rt, resend } = await start();
  try {
    const { person } = await rt.call<{ person: string }>("email.invite", {
      email: "ana@example.com",
    });
    const ana = await signUp(rt, resend.sent, "ana@example.com", "correct horse");
    assertEquals(ana.person, person);
    // Invited twice, either link works, until one is used.
    const bob = await rt.call<{ person: string }>("email.invite", { email: "bob@example.com" });
    const first = /#email-invite=([A-Za-z0-9_-]+)/.exec(resend.sent.at(-1)!.body.text)![1];
    await rt.call("email.invite", { email: "bob@example.com" });
    await ask(rt, "/signin/email/forgot", { email: "bob@example.com" });
    const reset = await ask(rt, "/signin/email/reset", {
      email: "bob@example.com",
      code: codeTo(resend.sent, "bob@example.com").code,
      password: "correct horse",
    });
    assertEquals(reset.said.person, bob.person);
    // A password set: the links waiting are spent.
    assertEquals(
      (await ask(rt, "/signin/email/accept", { token: first, password: "x".repeat(9) })).status,
      400,
    );
  } finally {
    await rt.close();
  }
});

/** Hashes as Copilotz 0.x apps kept them (computed apart, with Python's hashlib): PBKDF2-SHA256, 100,000, hex. */
const LEGACY = {
  plain: {
    password: "senha-forte-123",
    hash:
      "8f3a1c5e9b2d4f6071829304a5b6c7d8:fb909a2404cf6babec6ab30f2acff832eb13c7a1954cfa722449ad3db5c27f68",
  },
  unicode: {
    password: "pão de açúcar 🍞",
    hash:
      "00112233445566778899aabbccddeeff:8292fbec00a55560de1c361103f1803553a39bd986dbfa5bfc4eacf1d143f38a",
  },
};

test("passwords: production's hashes verify as stored; ours are staged, self-describing, made stronger", async () => {
  for (const { password, hash } of Object.values(LEGACY)) {
    assertEquals(await verifyPassword(password, hash), true);
    assertEquals(await verifyPassword(password, hash.toUpperCase()), true);
    assertEquals(await verifyPassword(`${password} `, hash), false);
  }
  // Staged PBKDF2, computed apart: two stages of 1,000, and one (plain PBKDF2).
  assertEquals(
    await verifyPassword(
      "correct horse",
      "pbkdf2-sha256$2x1000$AAECAwQFBgcICQoLDA0ODw$wrBCwjoqW0XtbwXdUFqoiGAhcMIuo9s48TrovB_tF6Y",
    ),
    true,
  );
  assertEquals(
    await verifyPassword(
      "correct horse",
      "pbkdf2-sha256$1x1000$AAECAwQFBgcICQoLDA0ODw$yRTMTwbMbo9G0VfjobWqerzuuxe7BETNTErBbKKumGQ",
    ),
    true,
  );
  const made = await hashPassword("correct horse");
  assertMatch(made, /^pbkdf2-sha256\$6x100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assertEquals(await verifyPassword("correct horse", made), true);
  assertEquals(await verifyPassword("correct horsf", made), false);
  // Salted: the same password never hashes the same twice.
  assert(made !== await hashPassword("correct horse"));
  for (const garbage of ["", "abc:def", "pbkdf2-sha256$0x1$a$b", "bcrypt$2b$..."]) {
    assertEquals(await verifyPassword("correct horse", garbage), false);
  }
});

test("moving in: production's hashes kept as they are sign in, and are hashed again, stronger", async () => {
  const store = memoryStore();
  const { rt } = await start({ store });
  try {
    // The system's alone.
    await assertRejects(() =>
      rt.call("email.import", { person: "p1", email: "ana@example.com", hash: LEGACY.plain.hash }, {
        actor: { kind: "person", id: "p1" },
      })
    );
    const imported = await rt.call("email.import", {
      person: "01HEXAMPLE01",
      email: "Ana@Example.com",
      hash: LEGACY.plain.hash,
      name: "Ana",
      at: "2025-03-01T12:00:00.000Z",
    });
    assertEquals(imported, { person: "01HEXAMPLE01", new: true });
    await rt.call("email.import", {
      person: "01HEXAMPLE02",
      email: "bia@example.com",
      hash: LEGACY.unicode.hash,
    });
    // Run again: the same, updated; someone else's address, refused; not a hash, refused.
    assertEquals(
      await rt.call("email.import", {
        person: "01HEXAMPLE01",
        email: "ana@example.com",
        hash: LEGACY.plain.hash,
      }),
      { person: "01HEXAMPLE01", new: false },
    );
    await assertRejects(
      () =>
        rt.call("email.import", {
          person: "other",
          email: "ana@example.com",
          hash: LEGACY.plain.hash,
        }),
      Error,
      "someone else's",
    );
    await assertRejects(
      () => rt.call("email.import", { person: "p3", email: "cy@example.com", hash: "plaintext" }),
      Error,
      "not a password hash",
    );

    const ana = await ask(rt, "/signin/email", {
      email: "ana@example.com",
      password: LEGACY.plain.password,
    });
    assertEquals([ana.status, ana.said.person], [200, "01HEXAMPLE01"]);
    const bia = await ask(rt, "/signin/email", {
      email: "bia@example.com",
      password: LEGACY.unicode.password,
    });
    assertEquals(bia.said.person, "01HEXAMPLE02");
    assertEquals(await rt.query("person.profile", { person: "01HEXAMPLE01" }), {
      name: "Ana",
      email: "ana@example.com",
    });
    // Hashed again on the way in: the same password signs in, the old hash is gone.
    const kept = await store.find("email_login", { _id: "ana@example.com" }, {}) as unknown as {
      hash?: string;
      at?: string;
    }[];
    assertMatch(kept[0].hash!, /^pbkdf2-sha256\$6x100000\$/);
    assertEquals(kept[0].at, "2025-03-01T12:00:00.000Z");
    assertEquals(
      (await ask(rt, "/signin/email", {
        email: "ana@example.com",
        password: LEGACY.plain.password,
      })).status,
      200,
    );
    assertEquals(
      (await ask(rt, "/signin/email", { email: "ana@example.com", password: "senha-forte-124" }))
        .status,
      401,
    );
  } finally {
    await rt.close();
  }
});

test("no password, hash, code, token or session is in the log, and no actor reads the plugin's records", async () => {
  const store = memoryStore();
  const { rt, resend } = await start({ store });
  try {
    const secrets: string[] = ["correct horse", "a new password", LEGACY.plain.hash];
    const ana = await signUp(rt, resend.sent, "ana@example.com", "correct horse");
    secrets.push(codeTo(resend.sent, "ana@example.com").code, ana.cookie.split("=")[1]);
    await ask(rt, "/signin/email/forgot", { email: "ana@example.com" });
    const { code } = codeTo(resend.sent, "ana@example.com");
    const reset = await ask(rt, "/signin/email/reset", {
      email: "ana@example.com",
      code,
      password: "a new password",
    });
    secrets.push(code, reset.cookie!.split("=")[1]);
    await rt.call("email.invite", { email: "bob@example.com" });
    const token = /#email-invite=([A-Za-z0-9_-]+)/.exec(resend.sent.at(-1)!.body.text)![1];
    const bob = await ask(rt, "/signin/email/accept", { token, password: "correct horse" });
    secrets.push(token, bob.cookie!.split("=")[1]);
    await rt.call("email.import", {
      person: "cy",
      email: "cy@example.com",
      hash: LEGACY.plain.hash,
    });
    const hashes = (await store.find("email_login", {}, {}) as unknown as { hash: string }[]).map((
      l,
    ) => l.hash);
    secrets.push(...hashes);
    await rt.idle();
    const logged = JSON.stringify(await store.events(0, 100_000));
    assert(logged.includes("email_login.created"));
    assertEquals(secrets.filter((s) => logged.includes(s)), []);
    // What an actor's own work reads of them: nothing, though they're there.
    assertEquals(await rt.call("t.peek", {}, { actor: { kind: "person", id: ana.person } }), {
      logins: 0,
      codes: 0,
    });
    assert((await store.find("email_login", {}, {})).length === 3);
  } finally {
    await rt.close();
  }
});

test("limits: messages to an address, tries at it, and what one caller asks, the same for anyone", async () => {
  const { rt, resend } = await start({ settings: { limits: { sends: 2, tries: 3, address: 6 } } });
  try {
    // Messages to one address: two an hour, whether or not it has an account.
    for (const address of ["ana@example.com", "nobody@example.com"]) {
      for (let i = 0; i < 2; i++) {
        assertEquals(
          (await ask(rt, "/signin/email/forgot", { email: address }, `198.51.100.${i}`)).status,
          200,
        );
      }
      const past = await ask(rt, "/signin/email/forgot", { email: address }, "198.51.100.50");
      assertEquals([past.status, past.said.code, past.retry], [429, "too_many", "900"]);
      assertMatch(past.said.error, /several emails/);
    }
    // Tries at one address: three in 15 minutes, from anywhere.
    await rt.call("email.import", {
      person: "bob",
      email: "bob@example.com",
      hash: LEGACY.plain.hash,
    });
    for (let i = 0; i < 3; i++) {
      assertEquals(
        (await ask(
          rt,
          "/signin/email",
          { email: "bob@example.com", password: "wrong one" },
          `192.0.2.${i}`,
        )).status,
        401,
      );
    }
    const locked = await ask(rt, "/signin/email", {
      email: "bob@example.com",
      password: LEGACY.plain.password,
    }, "192.0.2.77");
    assertEquals([locked.status, locked.said.code], [429, "too_many"]);
    // One caller: six asks in 15 minutes, whatever the address; another caller isn't held.
    for (let i = 0; i < 6; i++) {
      assertEquals(
        (await ask(
          rt,
          "/signin/email",
          { email: `p${i}@example.com`, password: "wrong one" },
          "203.0.113.99",
        )).status,
        401,
      );
    }
    const held = await ask(rt, "/signin/email/sign-up", {
      email: "new@example.com",
      password: "correct horse",
    }, "203.0.113.99");
    assertEquals([held.status, held.said.code], [429, "too_many"]);
    assertMatch(held.said.error, /from here/);
    assertEquals(
      (await ask(rt, "/signin/email/sign-up", {
        email: "new@example.com",
        password: "correct horse",
      }, "203.0.113.100")).status,
      200,
    );
    assert(resend.sent.length > 0);
  } finally {
    await rt.close();
  }
});

test("Resend gets each message as its API takes it; one that didn't go says so", async () => {
  const { rt, resend } = await start();
  try {
    await ask(rt, "/signin/email/sign-up", { email: "ana@example.com", password: "correct horse" });
    const [sent] = resend.sent;
    assertEquals(sent.url, "https://api.resend.com/emails");
    assertEquals(sent.authorization, `Bearer ${KEY}`);
    assertEquals(sent.body.from, "App <noreply@app.example.com>");
    assertEquals(sent.body.to, ["ana@example.com"]);
    assert(sent.body.text && sent.body.html);
    resend.state.failing = true;
    const failed = await ask(rt, "/signin/email/sign-up", {
      email: "bob@example.com",
      password: "correct horse",
    });
    assertEquals([failed.status, failed.said.code], [503, "unavailable"]);
    // Forgot answers the same, though: it says nothing of who has an account.
    await rt.call("person.set", { person: "cy", email: "cy@example.com" });
    assertEquals((await ask(rt, "/signin/email/forgot", { email: "cy@example.com" })).status, 200);
    // Other plugins send through the port too.
    resend.state.failing = false;
    await rt.call("email.send", {
      to: "dan@example.com",
      subject: "Your receipt",
      text: "Thanks.",
    });
    assertEquals(resend.sent.at(-1)!.body.subject, "Your receipt");
    await assertRejects(() =>
      rt.call("email.send", { to: "dan@example.com", subject: "x", text: "y" }, {
        actor: { kind: "person", id: "dan" },
      })
    );
  } finally {
    await rt.close();
  }
});

test("an app's words: messages in its language and name, with what fills them escaped in HTML", async () => {
  const { rt, resend } = await start({
    settings: {
      app: "Ana & Bia",
      messages: {
        verify: {
          subject: "{code} é o seu código da {app}",
          text: "Seu código: {code} ({minutes} minutos)",
        },
      },
    },
  });
  try {
    await ask(rt, "/signin/email/sign-up", { email: "ana@example.com", password: "correct horse" });
    const { code, message } = codeTo(resend.sent, "ana@example.com");
    assertEquals(message.body.subject, `${code} é o seu código da Ana & Bia`);
    assertEquals(message.body.text, `Seu código: ${code} (15 minutos)`);
    // Its HTML is the default's, its blanks filled and escaped.
    assert(message.body.html?.includes("Ana &amp; Bia"));
    assertEquals(message.body.html?.includes("Ana & Bia"), false);
  } finally {
    await rt.close();
  }
});

test("signUp: false leaves only invitations; the page is told", async () => {
  const { rt } = await start({ settings: { signUp: false } });
  try {
    assertEquals(await (await rt.fetch(new Request("http://localhost/signin/email"))).json(), {
      signUp: false,
    });
    const refused = await ask(rt, "/signin/email/sign-up", {
      email: "ana@example.com",
      password: "correct horse",
    });
    assertEquals([refused.status, refused.said.code], [403, "forbidden"]);
  } finally {
    await rt.close();
  }
});

test("codes the secret before sealed still work while the app changes its secret", async () => {
  const store = memoryStore();
  const first = await start({ store });
  await ask(first.rt, "/signin/email/sign-up", {
    email: "ana@example.com",
    password: "correct horse",
  });
  const { code } = codeTo(first.resend.sent, "ana@example.com");
  await first.rt.close();
  const next = { origin: LINKS.origin, secret: "the-next-secret-for-tests-9876543210" };
  const second = await start({ store, links: { ...next, previous: LINKS.secret } });
  try {
    const verified = await ask(second.rt, "/signin/email/verify", {
      email: "ana@example.com",
      code,
    });
    assertEquals(verified.status, 200);
  } finally {
    await second.rt.close();
  }
});

test("what the plugins need is checked as they start", async () => {
  const plugins = (resources: Record<string, Record<string, unknown>>) => [
    ...access,
    email,
    emailSignIn,
    definePlugin({ name: "app", resources }),
  ];
  const resend = { adapter: "resend", from: "App <a@b.c>", apiKey: KEY };
  await assertRejects(
    () => createRuntime({ store: memoryStore(), plugins: plugins({ email: resend }) }),
    Error,
    "links",
  );
  await assertRejects(
    () => createRuntime({ store: memoryStore(), plugins: plugins({ links: LINKS }) }),
    Error,
    "adapter",
  );
  await assertRejects(
    () =>
      createRuntime({
        store: memoryStore(),
        plugins: plugins({ links: LINKS, email: { adapter: "resend" } }),
      }),
    Error,
    "apiKey",
  );
  // The console adapter, for a laptop: not where the app is public.
  await assertRejects(
    () =>
      createRuntime({
        store: memoryStore(),
        plugins: plugins({ links: LINKS, email: { adapter: "console" } }),
      }),
    Error,
    "public",
  );
  const logged: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void logged.push(args.join(" "));
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: plugins({
      links: { origin: "http://localhost:8790", secret: LINKS.secret },
      email: { adapter: "console" },
    }),
  });
  try {
    await ask(rt, "/signin/email/sign-up", { email: "ana@example.com", password: "correct horse" });
    assert(
      logged.some((line) => line.includes("[email] to ana@example.com") && /\d{6}/.test(line)),
    );
  } finally {
    console.log = log;
    await rt.close();
  }
});

test("past an address's messages this hour, signing in unconfirmed sends none: the last code works", async () => {
  const { rt, resend } = await start({ settings: { limits: { sends: 2 } } });
  try {
    await ask(rt, "/signin/email/sign-up", { email: "ana@example.com", password: "correct horse" });
    const first = await ask(rt, "/signin/email", {
      email: "ana@example.com",
      password: "correct horse",
    });
    assertMatch(first.said.error, /we've sent a new code/);
    const { code } = codeTo(resend.sent, "ana@example.com");
    const sent = resend.sent.length;
    const second = await ask(rt, "/signin/email", {
      email: "ana@example.com",
      password: "correct horse",
    });
    assertEquals([second.status, second.said.code], [403, "unverified"]);
    assertMatch(second.said.error, /enter the code we sent/);
    assertEquals(resend.sent.length, sent);
    assertEquals(
      (await ask(rt, "/signin/email/verify", { email: "ana@example.com", code })).status,
      200,
    );
  } finally {
    await rt.close();
  }
});

test("behind the app's front, callers are told apart by its word, and nothing comes around it", async () => {
  const FRONT = "the-front-secret-for-tests-0123";
  const { rt } = await start({
    settings: { limits: { address: 2 } },
    more: [
      definePlugin({
        name: "front",
        resources: { caller: { header: "cf-connecting-ip", front: FRONT } },
      }),
    ],
  });
  const from = (address: string | null, body: unknown) =>
    rt.fetch(setClientAddress(
      new Request("http://localhost/signin/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(address ? { "x-copilotz-front": FRONT, "cf-connecting-ip": address } : {}),
        },
        body: JSON.stringify(body),
      }),
      "10.0.0.2",
    ));
  try {
    const around = await read(await from(null, { email: "ana@example.com", password: "x" }));
    assertEquals([around.status, around.said.code], [403, "forbidden"]);
    // Two callers, one proxy's address between them: each held on its own.
    for (let i = 0; i < 2; i++) {
      assertEquals(
        (await from("198.51.100.1", { email: `a${i}@example.com`, password: "x" })).status,
        401,
      );
    }
    assertEquals(
      (await from("198.51.100.1", { email: "a9@example.com", password: "x" })).status,
      429,
    );
    assertEquals(
      (await from("198.51.100.2", { email: "a9@example.com", password: "x" })).status,
      401,
    );
  } finally {
    await rt.close();
  }
});
