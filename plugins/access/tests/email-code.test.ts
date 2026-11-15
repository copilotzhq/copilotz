/**
 * Email sign-in by a code sent to the address (`signInByCode`): offered
 * only when the app says, to an address someone has (with sign-up, to any,
 * whose code makes the account), the same answer either way; the code signs
 * in, confirms an invited address, and leaves a password as it was. And
 * what's said per host the page is served on (`hosts`): its name, words,
 * sender and links.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  definePlugin,
  type Runtime,
  setClientAddress,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { access, email, emailSignIn } from "../mod.ts";
import { test } from "../../../testing/mod.ts";

const LINKS = { origin: "https://app.example.com", secret: "the-app-secret-for-tests-0123456789" };

type Sent = { from: string; to: string[]; subject: string; text: string; html?: string };

async function start(settings: Record<string, unknown> = {}, mail: Record<string, unknown> = {}) {
  const sent: Sent[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(JSON.parse(await new Request(input, init).text()));
    return Response.json({ id: `m${sent.length}` });
  }) as typeof globalThis.fetch;
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [
      ...access,
      email,
      emailSignIn,
      definePlugin({
        name: "app",
        resources: {
          links: LINKS,
          email: { adapter: "resend", from: "App <noreply@app.example.com>", apiKey: "k", ...mail },
          emailSignIn: settings,
        },
      }),
    ],
    fetch,
  });
  return { rt, sent };
}

/** A page's request to the app, on a host (`localhost` unless said). */
async function ask(rt: Runtime, path: string, body: unknown, host = "localhost") {
  const response = await rt.fetch(setClientAddress(
    new Request(`http://${host}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    "203.0.113.7",
  ));
  return {
    status: response.status,
    said: await response.json() as Record<string, string>,
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}

const codeIn = (message: Sent | undefined) => /\b(\d{6})\b/.exec(message?.text ?? "")?.[1];

const whoIs = (rt: Runtime, cookie: string) =>
  rt.query<Actor | null>("credential.actor", { secret: cookie.slice(cookie.indexOf("=") + 1) });

test("a code to sign in with: only where the app offers it", async () => {
  const off = await start();
  try {
    const here = await off.rt.fetch(new Request("http://localhost/signin/email"));
    assertEquals(await here.json(), { signUp: true });
    const refused = await ask(off.rt, "/signin/email/code", { email: "ana@example.com" });
    assertEquals([refused.status, refused.said.code], [403, "forbidden"]);
  } finally {
    await off.rt.close();
  }
  const on = await start({ signInByCode: true });
  try {
    const here = await on.rt.fetch(new Request("http://localhost/signin/email"));
    assertEquals(await here.json(), { signUp: true, code: true });
  } finally {
    await on.rt.close();
  }
});

test("someone invited signs in with a code: confirmed, as the same person, with no password", async () => {
  const { rt, sent } = await start({ signInByCode: true, signUp: false });
  try {
    const { person } = await rt.call<{ person: string }>("email.invite", {
      email: "ana@example.com",
      person: "ana-1",
    });
    // An address nobody has gets nothing, and the same answer.
    const before = sent.length;
    const nobody = await ask(rt, "/signin/email/code", { email: "bo@example.com" });
    assertEquals([nobody.status, nobody.said], [200, { email: "bo@example.com" }]);
    assertEquals(sent.length, before);
    const asked = await ask(rt, "/signin/email/code", { email: "Ana@Example.com" });
    assertEquals(asked.said, { email: "ana@example.com" });
    const message = sent.at(-1)!;
    assertEquals(message.subject, `${codeIn(message)} is your code to sign in to app.example.com`);
    // A wrong code, then the right one.
    const wrong = await ask(rt, "/signin/email/enter", {
      email: "ana@example.com",
      code: "000000",
    });
    assertEquals([wrong.status, wrong.said.code], [400, "invalid"]);
    const entered = await ask(rt, "/signin/email/enter", {
      email: "ana@example.com",
      code: codeIn(message),
    });
    assertEquals([entered.status, entered.said.person], [200, person]);
    assertEquals((await whoIs(rt, entered.cookie!))?.id, "ana-1");
    // Spent: it works once.
    const again = await ask(rt, "/signin/email/enter", {
      email: "ana@example.com",
      code: codeIn(message),
    });
    assertEquals(again.status, 400);
    // Signing in with a password: she has none.
    const password = await ask(rt, "/signin/email", {
      email: "ana@example.com",
      password: "anything-at-all",
    });
    assertEquals(password.status, 401);
  } finally {
    await rt.close();
  }
});

test("with sign-up on, a code to a new address makes the account; a password kept stays", async () => {
  const { rt, sent } = await start({ signInByCode: true });
  try {
    await ask(rt, "/signin/email/code", { email: "new@example.com" });
    const made = await ask(rt, "/signin/email/enter", {
      email: "new@example.com",
      code: codeIn(sent.at(-1)),
      name: "Nina",
    });
    assertEquals(made.status, 200);
    assert(made.said.person.startsWith("email:"));
    assertEquals(await rt.query("person.profile", { person: made.said.person }), {
      name: "Nina",
      email: "new@example.com",
    });
    // Someone with a password signs in by a code too, and their password still works.
    await rt.call("email.import", {
      person: "bia-1",
      email: "bia@example.com",
      hash: "$2y$10$.vGA1O9wmRjrwAVXD98HNOgsNpDczlqm3Jq7KnEd1rVAGv3Fykk1a",
    });
    await ask(rt, "/signin/email/code", { email: "bia@example.com" });
    const bia = await ask(rt, "/signin/email/enter", {
      email: "bia@example.com",
      code: codeIn(sent.at(-1)),
    });
    assertEquals(bia.said.person, "bia-1");
    const withPassword = await ask(rt, "/signin/email", {
      email: "bia@example.com",
      password: "rasmuslerdorf",
    });
    assertEquals([withPassword.status, withPassword.said.person], [200, "bia-1"]);
  } finally {
    await rt.close();
  }
});

test("per host: its name, words, sender and links; any other host, the app's", async () => {
  const { rt, sent } = await start({
    signInByCode: true,
    app: "Abordo",
    hosts: {
      "passaromarron.example": {
        app: "Pássaro Marron",
        from: "Pássaro Marron <nao-responda@passaromarron.example>",
        messages: {
          signin: { subject: "{code} é o seu código no {app}" },
          invite: { subject: "Crie sua senha no {app}" },
        },
      },
    },
  }, { senders: ["@passaromarron.example"] });
  try {
    await ask(rt, "/signin/email/code", { email: "ana@example.com" }, "passaromarron.example");
    await ask(rt, "/signin/email/sign-up", {
      email: "ana@example.com",
      password: "senha-forte-123",
    }, "passaromarron.example");
    const [code, verify] = sent.slice(-2);
    assertEquals(code.from, "Pássaro Marron <nao-responda@passaromarron.example>");
    assertEquals(code.subject, `${codeIn(code)} é o seu código no Pássaro Marron`);
    // Words it doesn't change are the app's, its name filled in.
    assertEquals(verify.subject, `${codeIn(verify)} is your code for Pássaro Marron`);
    // Elsewhere, the app's.
    await ask(rt, "/signin/email/code", { email: "bo@example.com" }, "app.example.com");
    assertEquals(sent.at(-1)!.from, "App <noreply@app.example.com>");
    assertEquals(sent.at(-1)!.subject, `${codeIn(sent.at(-1))} is your code to sign in to Abordo`);
    // An invitation for the host links there.
    await rt.call("email.invite", { email: "caio@example.com", host: "passaromarron.example" });
    const invite = sent.at(-1)!;
    assertEquals(invite.subject, "Crie sua senha no Pássaro Marron");
    assert(invite.text.includes("https://passaromarron.example/#email-invite="));
  } finally {
    await rt.close();
  }
  // A host's sender the email resource doesn't allow is said at start.
  await assertRejects(
    () =>
      start({ hosts: { "b.example": { from: "B <hi@b.example>" } } }).then(({ rt }) => rt.close()),
    Error,
    "senders",
  );
});
