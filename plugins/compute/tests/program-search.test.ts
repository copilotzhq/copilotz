/**
 * The computer's web search, against a local page shaped like DuckDuckGo's:
 * results read in order, redirect links undone, ads left out; it says what
 * it is (not a browser); a search that's turned away (with no browser to
 * try) says so. With COPILOTZ_TEST_DUCKDUCKGO=1, it searches DuckDuckGo
 * itself, by fetch and in the browser.
 */
import { assert, assertEquals } from "@std/assert";
import { env, serve, test } from "../../../testing/mod.ts";
import { findChrome } from "../computers/program/browser/mod.ts";
import type { Result } from "../computers/program/browser/types.ts";
import { AGENT, parseResults } from "../computers/program/workloads/search.ts";
import { type Scope, type SearchResult, WORK } from "../computers/shared/workloads.ts";
import { RESULTS, TURNED_AWAY } from "./program-pages.ts";
import { setup } from "./program-setup.ts";

const scope: Scope = { space: "space-alpha", folder: "alpha", who: "agent:a" };

test("a DuckDuckGo page reads as results", () => {
  assertEquals(parseResults(RESULTS), [
    {
      title: "Deno, the & runtime",
      url: "https://deno.com/",
      snippet: 'A runtime with "batteries"',
    },
    {
      title: "About Node.js's runtime",
      url: "https://nodejs.org/en/about?a=1&b=2",
      snippet: "Node's event loop",
    },
    { title: "Bun", url: "https://bun.sh/", snippet: "Fast" },
  ]);
  assertEquals(parseResults(TURNED_AWAY), []);
});

test("a search from the computer: its results, as many as asked", async () => {
  const asked: { method: string; query: string | null }[] = [];
  const agents: string[] = [];
  const server = await serve(async (request) => {
    const form = request.method === "POST" ? new URLSearchParams(await request.text()) : undefined;
    const query = form?.get("q") ?? new URL(request.url).searchParams.get("q");
    asked.push({ method: request.method, query });
    agents.push(request.headers.get("user-agent") ?? "");
    if (query === "robots") return new Response(TURNED_AWAY, { status: 202 });
    return new Response(RESULTS, { headers: { "content-type": "text/html" } });
  });
  try {
    await setup(async ({ work }) => {
      const found = await work<SearchResult[]>(WORK.search, { scope, query: "  runtimes  " });
      assertEquals(found.map((r) => r.url), [
        "https://deno.com/",
        "https://nodejs.org/en/about?a=1&b=2",
        "https://bun.sh/",
      ]);
      const two = await work<SearchResult[]>(WORK.search, { scope, query: "runtimes", limit: 2 });
      assertEquals(two.length, 2);
      assertEquals(asked[0], { method: "POST", query: "runtimes" });
      // It says what it is: no browser.
      assert(AGENT.startsWith("copilotz-computer/"), AGENT);
      assertEquals(agents[0], AGENT);
      // Turned away, with no browser to try it in.
      const blocked = await work<{ error: { code: string } }>(WORK.search, {
        scope,
        query: "robots",
      });
      assertEquals(blocked.error.code, "blocked");
      const empty = await work<{ error: { code: string } }>(WORK.search, { scope, query: " " });
      assertEquals(empty.error.code, "invalid");
    }, { searchUrl: `${server.url}/html/` });
  } finally {
    await server.close();
  }
});

test({
  name: "DuckDuckGo itself: a search by fetch, and in the browser",
  ignore: env("COPILOTZ_TEST_DUCKDUCKGO") !== "1",
  fn: async () => {
    const chrome = await findChrome();
    await setup(async ({ work }) => {
      const found = await work<SearchResult[] | { error: unknown }>(WORK.search, {
        scope,
        query: "deno javascript runtime",
      });
      assert(Array.isArray(found) && found.length, JSON.stringify(found));
      if (!chrome) return;
      // Spaced, so DuckDuckGo doesn't take the two for a robot's.
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      const browsed = await work<Result>(WORK.browser, {
        scope,
        actions: [{ action: "web_search", query: "node.js event loop", count: 5 }],
      });
      const result = browsed.results[0];
      assert(browsed.success && !result.blocked, JSON.stringify(browsed));
      assert((result.results as SearchResult[]).length, JSON.stringify(result));
    }, { chromium: chrome });
  },
});
