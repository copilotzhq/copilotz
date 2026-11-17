/**
 * A route's own page (route-page.ts): the app's theme in its head, the
 * toolkit's styles for what it shows there too, its words the app's, its
 * title escaped, and the route's status and headers.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import type { Resources } from "../../../runtime/mod.ts";
import { routePage, routePageHtml } from "../route-page.ts";
import { themeOf } from "../theme/css.ts";
import { Button } from "../toolkit/button.tsx";
import { TagsInput } from "../toolkit/tags-input.tsx";

const brand = {
  name: "brand",
  resources: {
    theme: { light: { primary: "#0f766e" }, font: { url: "/assets/fonts/brand.css" } },
  },
};

const resources = {
  theme: themeOf([brand as never]),
  page: { lang: "pt-BR" },
  words: { "toolkit.removeTag": "Tirar {tag}" },
} as unknown as Resources;

const FORM = (
  <form method="post" action="/login">
    <TagsInput label="Formatos" values={["EAN13"]} onChange={() => {}} />
    <Button type="submit" variant="primary">Entrar</Button>
  </form>
);

test("the head has the theme and the toolkit's styles; the body, what it shows", () => {
  const page = routePageHtml(resources, { title: "Entrar", body: FORM });
  const [head, body] = page.split("</head>");
  assertStringIncludes(page, '<html lang="pt-BR">');
  assertStringIncludes(head, "--primary: #0f766e;");
  assertStringIncludes(head, "@layer copilotz-base, copilotz-toolkit;");
  assertStringIncludes(head, '<link rel="stylesheet" href="/assets/fonts/brand.css">');
  // Each piece's style, once, in the head, after the theme (whose layers come first).
  assertStringIncludes(head, ".copilotz-button {");
  assertStringIncludes(head, ".copilotz-tags-input {");
  assert(head.indexOf("copilotz-first-paint") < head.indexOf("data-precedence"));
  assert(!body.includes("<style"));
  assert(/<form [^>]*action="\/login"/.test(body) && /<form [^>]*method="post"/.test(body));
  assertStringIncludes(body, "Entrar</button>");
  // The app's words.
  assertStringIncludes(body, 'aria-label="Tirar EAN13"');
});

test("its title is escaped, and with no theme it's Copilotz's", () => {
  const page = routePageHtml({} as Resources, { title: '<script>"x"&', body: <p>Oi</p> });
  assertStringIncludes(page, "<title>&lt;script>&quot;x&quot;&amp;</title>");
  assert(!page.includes("<script>"));
  assertStringIncludes(page, '<html lang="en">');
  assertStringIncludes(page, "--font-sans:");
});

test("the route's answer: its status, its headers over the page's, never kept unless said", async () => {
  const runtime = { describe: () => ({ resources }) };
  const refused = routePage(runtime, { title: "Entrar", body: FORM, status: 401 });
  assertEquals(refused.status, 401);
  assertEquals(refused.headers.get("content-type"), "text/html; charset=utf-8");
  assertEquals(refused.headers.get("cache-control"), "no-store");
  assertStringIncludes(await refused.text(), "Tirar EAN13");
  const kept = routePage(runtime, {
    title: "Recibo",
    body: <p>Recibo</p>,
    headers: { "cache-control": "private, max-age=60", "x-frame-options": "DENY" },
  });
  assertEquals(kept.status, 200);
  assertEquals(kept.headers.get("cache-control"), "private, max-age=60");
  assertEquals(kept.headers.get("x-frame-options"), "DENY");
  await kept.body?.cancel();
});
