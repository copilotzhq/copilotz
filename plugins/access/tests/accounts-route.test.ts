/**
 * Connected accounts through the web host: a provider that sends people back
 * to the app (most do: GitHub's, Google's) finishes the sign-in at the
 * app's callback route, as the person the session cookie signs in, and
 * lands them on Connected accounts saying how it went; a visitor, or
 * someone else's session, finishes nothing.
 */
import { assertEquals } from "@std/assert";
import { type Actor, createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { access } from "../mod.ts";
import { accounts, type Connecting } from "../accounts/mod.ts";
import { createTickets } from "../../../hosts/web/tickets.ts";
import { webServer } from "../../../hosts/web/server.ts";
import { test } from "../../../testing/mod.ts";
import { CLIENT, fakeOpenAI } from "./openai-fake.ts";

const ana: Actor = { kind: "person", id: "ana" };

test("a provider that sends people back to the app finishes at its route, as its person", async () => {
  const openai = await fakeOpenAI();
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [
      ...access,
      accounts,
      definePlugin({
        name: "app",
        resources: {
          accountProviders: {
            // Any OAuth provider: this one is the stand-in's server, sending people to the app.
            forge: {
              title: "Forge",
              allows: "Agents working for you read your repositories.",
              oauth: {
                authorize: `${openai.url}/oauth/authorize`,
                token: `${openai.url}/oauth/token`,
                clientId: CLIENT,
                scopes: ["repo"],
              },
              profile: () => ({ id: "forge-ana", label: "ana" }),
            },
          },
        },
      }),
    ],
  });
  const serve = webServer({
    runtime: rt,
    tickets: createTickets(),
    code: { entry: "app.js", files: { "app.js": "" } },
    upgrade: () => new Response(null, { status: 299 }),
    dev: true,
  });
  const signIn = async (name: string) => {
    const answer = await serve(
      new Request("http://localhost/signin/dev", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    );
    return answer.headers.get("set-cookie")!.split(";")[0];
  };
  const start = async () => {
    const started = await rt.call<Connecting>("account.connect", {
      provider: "forge",
      origin: "http://localhost",
    }, { actor: ana });
    assertEquals(started.paste, undefined);
    return openai.signIn(started.url, "ana");
  };
  const land = async (address: string, cookie?: string) => {
    const answer = await serve(new Request(address, { headers: cookie ? { cookie } : {} }));
    assertEquals(answer.status, 302);
    assertEquals(answer.headers.get("cache-control"), "no-store");
    return answer.headers.get("location");
  };
  try {
    const anas = await signIn("ana");
    const bobs = await signIn("bob");
    const landing = await start();
    assertEquals(new URL(landing).pathname, "/accounts/callback/forge");
    // Signed out, or signed in as someone else: nothing is finished.
    assertEquals(await land(landing), "/accounts?failed=forge&why=signed_out");
    assertEquals(await land(landing, bobs), "/accounts?failed=forge&why=invalid");
    assertEquals(await land(landing, anas), "/accounts?connected=forge");
    // Used once.
    assertEquals(await land(landing, anas), "/accounts?failed=forge&why=invalid");
    // Not allowed there: said by code, never in the provider's words.
    const denied = new URL(await start());
    denied.searchParams.delete("code");
    denied.searchParams.set("error", "access_denied");
    denied.searchParams.set("error_description", "<script>alert(1)</script>");
    assertEquals(await land(denied.href, anas), "/accounts?failed=forge&why=account_refused");
    // The page's origin decides where it sends people, unless the app says.
    const started = await rt.call<Connecting>("account.connect", { provider: "forge" }, {
      actor: ana,
    }).catch((e) => e.message);
    assertEquals(
      started,
      "Connecting needs the app's address: set `accounts.url`, or send the page's origin",
    );
    // It was connected, as Ana's.
    assertEquals(await rt.call("account.disconnect", { provider: "forge" }, { actor: ana }), {
      disconnected: true,
    });
  } finally {
    await rt.close();
    await openai.close();
  }
});
