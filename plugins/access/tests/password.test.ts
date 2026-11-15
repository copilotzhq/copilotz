/**
 * Password sign-in, through its routes as a page uses them: accounts trusted
 * code makes (`password.set`, `password.import` with bcrypt), signing in by
 * an identifier read without spaces, case or what the app ignores, one
 * refusal for anything wrong, a person changing their own password (their
 * other sessions end), an account removed, and the limits. No password,
 * hash or session is in the log, and no actor reads the plugin's records.
 */
import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  type Runtime,
  setClientAddress,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { access, passwordSignIn } from "../mod.ts";
import { test } from "../../../testing/mod.ts";

/** Test-only: what an actor's own work reads of the plugin's records (nothing). */
const peek = definePlugin({
  name: "peek",
  actions: {
    "t.peek": defineAction({
      input: { type: "object" },
      allow: () => true,
      run: async (ctx) => ({
        logins: await ctx.db.collection("password_login").countDocuments({}),
      }),
    }),
  },
});

async function start(settings?: Record<string, unknown>) {
  const store = memoryStore();
  const rt = await createRuntime({
    store,
    plugins: [
      ...access,
      passwordSignIn,
      peek,
      ...(settings ? [definePlugin({ name: "app", resources: { passwordSignIn: settings } })] : []),
    ],
  });
  return { rt, store };
}

/** A page's request, from a caller's address, with a cookie when it has one. */
const post = (rt: Runtime, path: string, body: unknown, cookie?: string, from = "203.0.113.7") =>
  rt.fetch(setClientAddress(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
    from,
  ));

async function ask(rt: Runtime, path: string, body: unknown, cookie?: string, from?: string) {
  const response = await post(rt, path, body, cookie, from);
  return {
    status: response.status,
    said: await response.json() as Record<string, string>,
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}

/** Who a session cookie proves. */
const whoIs = (rt: Runtime, cookie: string) =>
  rt.query<Actor | null>("credential.actor", { secret: cookie.slice(cookie.indexOf("=") + 1) });

test("an account trusted code makes signs in by its identifier, read without spaces or case", async () => {
  const { rt } = await start();
  try {
    // The page asks whether it's here.
    const here = await rt.fetch(new Request("http://localhost/signin/password"));
    assertEquals([here.status, await here.json()], [200, {}]);
    // The system's alone.
    await assertRejects(() =>
      rt.call("password.set", { person: "p", identifier: "x", password: "long enough" }, {
        actor: { kind: "person", id: "p" },
      })
    );
    const made = await rt.call("password.set", {
      person: "emp-7",
      identifier: " Ana.Lima ",
      password: "senha-forte-123",
      name: "Ana Lima",
    });
    assertEquals(made, { person: "emp-7", new: true });
    const signed = await ask(rt, "/signin/password", {
      identifier: "ANA.LIMA",
      password: "senha-forte-123",
    });
    assertEquals([signed.status, signed.said.person], [200, "emp-7"]);
    assertEquals((await whoIs(rt, signed.cookie!))?.id, "emp-7");
    assertEquals(await rt.query("person.profile", { person: "emp-7" }), { name: "Ana Lima" });
    // A wrong password and an identifier nobody has are one refusal.
    const wrong = await ask(rt, "/signin/password", {
      identifier: "ana.lima",
      password: "senha-forte-124",
    });
    const nobody = await ask(rt, "/signin/password", {
      identifier: "bia",
      password: "senha-forte-123",
    });
    assertEquals([wrong.status, wrong.said.code], [401, "unauthorized"]);
    assertEquals(nobody.said, wrong.said);
    assertEquals(wrong.cookie, undefined);
    // Too short a password, and someone else's identifier, are refused.
    await assertRejects(
      () => rt.call("password.set", { person: "emp-8", identifier: "bia", password: "short" }),
      Error,
      "at least 8",
    );
    await assertRejects(
      () => rt.call("password.set", { person: "emp-8", identifier: "ana.lima" }),
      Error,
      "someone else's",
    );
  } finally {
    await rt.close();
  }
});

test("what the app ignores in identifiers, it ignores wherever they're typed", async () => {
  const { rt } = await start({ ignore: ".-/" });
  try {
    await rt.call("password.set", {
      person: "driver-1",
      identifier: "123.456.789-09",
      password: "senha-forte-123",
    });
    for (const typed of ["12345678909", "123.456.789-09", " 123 456 789 09 "]) {
      const signed = await ask(rt, "/signin/password", {
        identifier: typed,
        password: "senha-forte-123",
      });
      assertEquals(signed.said.person, "driver-1");
    }
  } finally {
    await rt.close();
  }
});

test("moving in with bcrypt, a new identifier, a new password from an admin, and removed", async () => {
  const { rt, store } = await start();
  try {
    // PHP's password_hash("rasmuslerdorf"), as OSPOS keeps it.
    const hash = "$2y$10$.vGA1O9wmRjrwAVXD98HNOgsNpDczlqm3Jq7KnEd1rVAGv3Fykk1a";
    await rt.call("password.import", {
      person: "emp-1",
      identifier: "admin",
      hash,
      name: "Admin",
      at: "2019-01-01T00:00:00.000Z",
    });
    await assertRejects(
      () => rt.call("password.import", { person: "emp-2", identifier: "x", hash: "md5:abc" }),
      Error,
      "not a password hash",
    );
    const first = await ask(rt, "/signin/password", {
      identifier: "admin",
      password: "rasmuslerdorf",
    });
    assertEquals(first.said.person, "emp-1");
    // Hashed again our way, on the way in.
    const [kept] = await store.find("password_login", { _id: "admin" }) as unknown as {
      hash: string;
      at: string;
    }[];
    assertMatch(kept.hash, /^pbkdf2-sha256\$6x100000\$/);
    assertEquals(kept.at, "2019-01-01T00:00:00.000Z");
    // A new identifier keeps the password; the old one signs in no more.
    await rt.call("password.set", { person: "emp-1", identifier: "boss" });
    assertEquals(
      (await ask(rt, "/signin/password", { identifier: "boss", password: "rasmuslerdorf" }))
        .status,
      200,
    );
    assertEquals(
      (await ask(rt, "/signin/password", { identifier: "admin", password: "rasmuslerdorf" }))
        .status,
      401,
    );
    // A new password from an admin: every session of theirs ends.
    await rt.call("password.set", {
      person: "emp-1",
      identifier: "boss",
      password: "nova-senha-1",
    });
    assertEquals(await whoIs(rt, first.cookie!), null);
    const again = await ask(rt, "/signin/password", {
      identifier: "boss",
      password: "nova-senha-1",
    });
    assertEquals(again.status, 200);
    // Removed: no sign-in, no session.
    assertEquals(await rt.call("password.remove", { person: "emp-1" }), { removed: true });
    assertEquals(await whoIs(rt, again.cookie!), null);
    assertEquals(
      (await ask(rt, "/signin/password", { identifier: "boss", password: "nova-senha-1" }))
        .status,
      401,
    );
  } finally {
    await rt.close();
  }
});

test("a person changes their own password with the one they have; their other sessions end", async () => {
  const { rt } = await start();
  try {
    await rt.call("password.set", {
      person: "emp-3",
      identifier: "caio",
      password: "senha-forte-123",
    });
    const one = await ask(rt, "/signin/password", {
      identifier: "caio",
      password: "senha-forte-123",
    });
    const two = await ask(rt, "/signin/password", {
      identifier: "caio",
      password: "senha-forte-123",
    });
    // Signed out, or with the wrong password, nothing changes.
    const out = await ask(rt, "/signin/password/change", {
      password: "senha-forte-123",
      new: "outra-senha-456",
    });
    assertEquals([out.status, out.said.code], [401, "unauthorized"]);
    const wrong = await ask(rt, "/signin/password/change", {
      password: "not-it-at-all",
      new: "outra-senha-456",
    }, one.cookie);
    assertEquals(wrong.status, 401);
    assertEquals((await whoIs(rt, two.cookie!))?.id, "emp-3");
    const changed = await ask(rt, "/signin/password/change", {
      password: "senha-forte-123",
      new: "outra-senha-456",
    }, one.cookie);
    assertEquals([changed.status, changed.said.person], [200, "emp-3"]);
    assertEquals(await whoIs(rt, two.cookie!), null);
    assertEquals((await whoIs(rt, changed.cookie!))?.id, "emp-3");
    assertEquals(
      (await ask(rt, "/signin/password", { identifier: "caio", password: "outra-senha-456" }))
        .status,
      200,
    );
    // Never through an agent or a key: a person's own.
    await assertRejects(() =>
      rt.call("password.change", { password: "outra-senha-456", new: "x".repeat(10) }, {
        actor: { kind: "agent", id: "helper", for: { kind: "person", id: "emp-3" } },
      })
    );
  } finally {
    await rt.close();
  }
});

test("limits: tries at an identifier, and what one caller asks, the same for anyone", async () => {
  const { rt } = await start({ limits: { tries: 3, address: 5 } });
  try {
    await rt.call("password.set", {
      person: "emp-4",
      identifier: "dani",
      password: "senha-forte-123",
    });
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push(
        (await ask(
          rt,
          "/signin/password",
          { identifier: "dani", password: "nope-nope" },
          undefined,
          `198.51.100.${i}`,
        )).status,
      );
    }
    assertEquals(statuses, [401, 401, 401, 429]);
    // An identifier nobody has is counted the same.
    const nobody = [];
    for (let i = 0; i < 4; i++) {
      nobody.push(
        (await ask(
          rt,
          "/signin/password",
          { identifier: "ghost", password: "nope-nope" },
          undefined,
          `198.51.100.${10 + i}`,
        )).status,
      );
    }
    assertEquals(nobody, [401, 401, 401, 429]);
    // One caller: past its tries, whatever it asks.
    const caller = [];
    for (let i = 0; i < 6; i++) {
      caller.push(
        (await ask(
          rt,
          "/signin/password",
          { identifier: `who-${i}`, password: "nope-nope" },
          undefined,
          "192.0.2.9",
        )).status,
      );
    }
    assertEquals(caller, [401, 401, 401, 401, 401, 429]);
  } finally {
    await rt.close();
  }
});

test("no password, hash or session is in the log, and no actor reads the plugin's records", async () => {
  const { rt, store } = await start();
  try {
    const hash = "$2b$10$abcdefghijklmnopqrstuuGGgFFcYeueaAql8Z7U7CnCTRw4DR77W";
    await rt.call("password.import", { person: "emp-5", identifier: "eva", hash });
    await rt.call("password.set", {
      person: "emp-6",
      identifier: "fabio",
      password: "senha-forte-123",
    });
    const signed = await ask(rt, "/signin/password", {
      identifier: "fabio",
      password: "senha-forte-123",
    });
    const log = JSON.stringify(await store.events(0));
    for (const secret of [hash, "senha-forte-123", signed.cookie!.split("=")[1]]) {
      assert(!log.includes(secret), `the log holds ${secret.slice(0, 12)}…`);
    }
    assert(!log.includes("pbkdf2-sha256"));
    // On the record, without the hash.
    assert(log.includes("password_login.created"));
    assertEquals(
      await rt.call("t.peek", {}, { actor: { kind: "person", id: "emp-6" } }),
      { logins: 0 },
    );
  } finally {
    await rt.close();
  }
});
