import { assertEquals } from "@std/assert";

import web_search, {
  browserHeaderProfiles,
  buildBrowserHeaders,
  resolveAcceptLanguage,
} from "./index.ts";
import {
  cleanHtml,
  decodeDuckDuckGoUrl,
  isBotChallenge,
  parseDuckDuckGoHtml,
} from "./index.ts";

Deno.test("web_search parses DuckDuckGo html results", () => {
  const html = `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Falpha%3Fx%3D1&amp;rut=abc">
        Alpha &amp; Beta
      </a>
      <a class="result__snippet">First <b>snippet</b>&hellip;</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://example.org/direct">Second</a>
      <a class="result__snippet">Another result</a>
    </div>
  `;

  assertEquals(parseDuckDuckGoHtml(html, 10), [
    {
      title: "Alpha & Beta",
      url: "https://example.com/alpha?x=1",
      snippet: "First snippet ...",
    },
    {
      title: "Second",
      url: "https://example.org/direct",
      snippet: "Another result",
    },
  ]);
});

Deno.test("web_search detects bot challenges only when no results are present", () => {
  assertEquals(isBotChallenge('<form id="challenge-form"></form>'), true);
  assertEquals(
    isBotChallenge(
      '<form id="challenge-form"></form><a class="result__a" href="https://example.com">Result</a>',
    ),
    false,
  );
});

Deno.test("web_search decodes redirect urls and cleans html entities", () => {
  assertEquals(
    decodeDuckDuckGoUrl(
      "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs",
    ),
    "https://example.com/docs",
  );
  assertEquals(
    cleanHtml("One&nbsp;<strong>two</strong>&mdash;three"),
    "One two --three",
  );
});

Deno.test("web_search builds coherent browser headers", () => {
  const chromeWindows = browserHeaderProfiles.find((profile) =>
    profile.name === "chrome-windows"
  );
  if (!chromeWindows) throw new Error("Missing chrome-windows profile");

  const headers = buildBrowserHeaders(chromeWindows);
  assertEquals(headers["Sec-CH-UA-Platform"], '"Windows"');
  assertEquals(headers["Sec-CH-UA-Mobile"], "?0");
  assertEquals(headers["Accept-Language"], "en-US,en;q=0.9");
});

Deno.test("web_search aligns accept-language with region and language params", () => {
  assertEquals(
    resolveAcceptLanguage({ region: "br-pt" }, "en-US,en;q=0.9"),
    "pt-BR,pt;q=0.9,en-US;q=0.7,en;q=0.6",
  );
  assertEquals(
    resolveAcceptLanguage({ language: "pt_BR" }, "en-US,en;q=0.9"),
    "pt-BR,pt;q=0.9,en-US;q=0.7,en;q=0.6",
  );
});

Deno.test("web_search retries blocked responses with rotated headers and date filter", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: Headers }> = [];

  try {
    globalThis.fetch = ((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({
        url: String(input),
        headers: new Headers(init?.headers),
      });
      const body = calls.length === 1 ? '<form id="challenge-form"></form>' : `
          <a class="result__a" href="https://example.com">Example</a>
          <a class="result__snippet">Result body</a>
        `;
      return Promise.resolve(
        new Response(body, { status: 200, statusText: "OK" }),
      );
    }) as typeof fetch;

    const result = await web_search.execute?.({
      query: "fresh docs",
      region: "br-pt",
      timeRange: "week",
    });

    assertEquals((result as { count: number }).count, 1);
    assertEquals(calls.length, 2);

    const firstUrl = new URL(calls[0].url);
    assertEquals(firstUrl.searchParams.get("df"), "w");
    assertEquals(firstUrl.searchParams.get("kl"), "br-pt");
    assertEquals(
      calls[0].headers.get("accept-language"),
      "pt-BR,pt;q=0.9,en-US;q=0.7,en;q=0.6",
    );
    assertEquals(
      calls[0].headers.get("user-agent") !== calls[1].headers.get("user-agent"),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
