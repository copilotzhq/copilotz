import { assertEquals } from "@std/assert";

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
