/**
 * Contacts (people outside the org, writing on a line) are let into nothing of
 * team's or tiers': agents and their models are the org's people's to make
 * and choose. And yet the org's version of one of the app's agents is that
 * agent, for everyone it talks with: a contact's conversation reads it too.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { type Actor, createRuntime, definePlugin, type Runtime, setClientAddress } from "copilotz";
import { memoryStore } from "copilotz/stores/memory";
import models, { type LlmAdapter } from "copilotz/plugins/models";
import { chat } from "copilotz/plugins/agents";
import { access } from "copilotz/plugins/access";
import { webLines } from "copilotz/plugins/interfaces";
import { openTo, test } from "copilotz/testing";
import { team, tiers } from "../mod.ts";

test("no Action, query or event of team's or tiers' is open to a contact", () => {
  assertEquals(openTo({ kind: "contact", id: "c-someone" }, [team, tiers]), []);
});

/** What each model call was told to be. */
const told: string[] = [];
const script: LlmAdapter = {
  async *generate({ instructions }) {
    told.push(instructions ?? "");
    yield { type: "text", text: "ok" };
  },
};

const PAGE = "https://shop.example.com";

/** A web line's visitor, let in as its page lets them: who they are. */
async function visitor(runtime: Runtime): Promise<Actor> {
  const serve = (request: Request) => runtime.fetch(setClientAddress(request, "198.51.100.7"));
  const headers = { "content-type": "application/json", origin: PAGE };
  const arrived = await serve(
    new Request(`${PAGE}/web/desk`, { method: "POST", headers, body: "{}" }),
  );
  const cookie = arrived.headers.getSetCookie()[0].split(";")[0];
  await serve(new Request(`${PAGE}/connect`, { method: "POST", headers: { ...headers, cookie } }));
  return (await runtime.query<Actor | null>("contact_visitor.actor", {
    secret: cookie.split("=")[1],
  }))!;
}

test("the org's version of one of the app's agents answers a contact's conversation too", async () => {
  told.length = 0;
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      webLines,
      team,
      definePlugin({
        name: "app",
        adapters: { llm: { s: script } },
        resources: {
          provider: { s: { adapter: "s", apiKey: "k" } },
          agents: { guide: { instructions: "The app's words.", model: "s/guide" } },
          spaces: { visitors: { name: "Website", agents: ["guide"] } },
          links: { origin: PAGE, secret: "the-app-secret-for-tests-0123456789" },
          web: { desk: { in: "visitors", agent: "guide" } },
        },
      }),
    ],
  });
  try {
    await runtime.call("org.join", { person: "ana", role: "owner" });
    // The org's owner changes the app's agent: its version, over the app's.
    await runtime.call("agent.update", { agent: "guide", instructions: "The org's own words." }, {
      actor: { kind: "person", id: "ana" },
    });
    const someone = await visitor(runtime);
    await runtime.call("chat.send", { text: "Hello" }, { actor: someone });
    await runtime.idle();
    assertEquals(told.length, 1);
    assertStringIncludes(told.at(-1)!, "The org's own words.");
    assertEquals(told.at(-1)!.includes("The app's words."), false);
  } finally {
    await runtime.close();
  }
});
