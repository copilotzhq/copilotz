/**
 * The web toolkit's markdown: the blocks and spans agents' replies are drawn
 * from (as React elements, never as HTML, but for the MathML of math), links
 * that go only to the web, mail or the app (anything else stays text), and
 * formulas that draw only math.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { blocks } from "../toolkit/markdown/blocks.ts";
import { safeHref, spans } from "../toolkit/markdown/spans.ts";
import temml from "temml";
import { mathml } from "../toolkit/mathml.ts";
import { test } from "../../../testing/mod.ts";

const p = (text: string) => ({ type: "paragraph" as const, text });

test("blocks: headings, paragraphs with their line breaks, code, quotes, rules", () => {
  assertEquals(
    blocks(
      "# Title #\n\nHello **world**\nnext line\n\n```ts\nconst a = 1;\n```\n\n> quoted\n\n---",
    ),
    [
      { type: "heading", level: 1, text: "Title" },
      p("Hello **world**\nnext line"),
      { type: "code", lang: "ts", text: "const a = 1;", open: false },
      { type: "quote", blocks: [p("quoted")] },
      { type: "rule" },
    ],
  );
});

test("a code block still being written runs to the end, and says so", () => {
  assertEquals(blocks("Look:\n```py\nprint(1)\n"), [
    p("Look:"),
    { type: "code", lang: "py", text: "print(1)\n", open: true },
  ]);
});

test("lists nest by indentation, interrupt paragraphs, and tasks say whether they're done", () => {
  assertEquals(blocks("Steps:\n- a\n  - b\n- [x] c\n- [ ] d\n\n3. three\n4. four"), [
    p("Steps:"),
    {
      type: "list",
      ordered: false,
      start: 1,
      items: [
        {
          blocks: [p("a"), {
            type: "list",
            ordered: false,
            start: 1,
            items: [{ blocks: [p("b")] }],
          }],
        },
        { blocks: [p("c")], done: true },
        { blocks: [p("d")], done: false },
      ],
    },
    {
      type: "list",
      ordered: true,
      start: 3,
      items: [{ blocks: [p("three")] }, { blocks: [p("four")] }],
    },
  ]);
});

test("tables: the head, each column's alignment, the rows", () => {
  assertEquals(blocks("| A | B | C |\n| :-- | :-: | --: |\n| 1 | 2 \\| 3 | 4 |"), [{
    type: "table",
    head: ["A", "B", "C"],
    align: ["left", "center", "right"],
    rows: [["1", "2 | 3", "4"]],
  }]);
});

test("spans: code, strong, emphasis, strikethrough, escapes and line breaks", () => {
  assertEquals(spans("a `b` **c** *d* _e_ ~~f~~ \\*g\\* snake_case\nline"), [
    { type: "text", text: "a " },
    { type: "code", text: "b" },
    { type: "text", text: " " },
    { type: "strong", children: [{ type: "text", text: "c" }] },
    { type: "text", text: " " },
    { type: "em", children: [{ type: "text", text: "d" }] },
    { type: "text", text: " " },
    { type: "em", children: [{ type: "text", text: "e" }] },
    { type: "text", text: " " },
    { type: "del", children: [{ type: "text", text: "f" }] },
    { type: "text", text: " *g* snake_case" },
    { type: "break" },
    { type: "text", text: "line" },
  ]);
});

test("links go to the web, mail or the app; any other is its text", () => {
  assertEquals(
    spans("[ok](https://x.com) [bad](javascript:alert(1)) [app](/thread/1) see https://a.com/b."),
    [
      { type: "link", href: "https://x.com", children: [{ type: "text", text: "ok" }] },
      { type: "text", text: " bad) " },
      { type: "link", href: "/thread/1", children: [{ type: "text", text: "app" }] },
      { type: "text", text: " see " },
      {
        type: "link",
        href: "https://a.com/b",
        children: [{ type: "text", text: "https://a.com/b" }],
      },
      { type: "text", text: "." },
    ],
  );
  for (
    const bad of [
      "javascript:alert(1)",
      "data:text/html,<b>",
      "//evil.com",
      "/\\evil.com",
      "vbscript:x",
    ]
  ) {
    assertEquals(safeHref(bad), undefined, bad);
  }
  assertEquals(safeHref("mailto:ana@example.com"), "mailto:ana@example.com");
  assertEquals(safeHref("HTTPS://Example.com/a?b=1"), "HTTPS://Example.com/a?b=1");
});

test("math on its own lines, as models write it: \\[ … \\] or $$ … $$, kept whole", () => {
  const venus = [
    "Here's the equation:",
    "",
    "\\[",
    "\\frac{1}{T_{\\text{solar}}}",
    "=",
    "\\frac{1}{T_{\\text{rotation}}}",
    "+",
    "\\frac{1}{T_{\\text{orbit}}}",
    "\\]",
    "",
    "$$T = \\frac{243 \\times 225}{243 + 225}$$",
    "The plus sign is because Venus rotates backward.",
    "$$",
    "x^2",
  ].join("\n");
  assertEquals(blocks(venus), [
    p("Here's the equation:"),
    {
      type: "math",
      tex: "\\frac{1}{T_{\\text{solar}}}\n=\n\\frac{1}{T_{\\text{rotation}}}\n+\n" +
        "\\frac{1}{T_{\\text{orbit}}}",
      open: false,
    },
    { type: "math", tex: "T = \\frac{243 \\times 225}{243 + 225}", open: false },
    p("The plus sign is because Venus rotates backward."),
    // Still being written: it runs to the end.
    { type: "math", tex: "x^2", open: true },
  ]);
  // Math that's only the start of a line is the paragraph's.
  assertEquals(blocks("$$a$$ is a"), [p("$$a$$ is a")]);
});

test("math in a line: $…$ and \\(…\\); money and \\$ stay text", () => {
  const math = (tex: string, display = false) => ({ type: "math" as const, tex, display });
  const text = (text: string) => ({ type: "text" as const, text });
  assertEquals(spans("so $E = mc^2$ and \\(a_1\\), or $$x$$"), [
    text("so "),
    math("E = mc^2"),
    text(" and "),
    math("a_1"),
    text(", or "),
    math("x", true),
  ]);
  assertEquals(spans("It costs $5 and $10, or $5-$10."), [text("It costs $5 and $10, or $5-$10.")]);
  assertEquals(spans("\\$x\\$ and `$y$`"), [text("$x$ and "), { type: "code", text: "$y$" }]);
  assertEquals(spans("$x_1$ *and* $y_2$"), [
    math("x_1"),
    text(" "),
    { type: "em", children: [text("and")] },
    text(" "),
    math("y_2"),
  ]);
});

test("a formula is MathML, and only math: TeX's links, classes and loops draw nothing else", () => {
  const drawn = mathml(temml, "\\frac{1}{T} + \\sqrt{x}", true);
  assert("mathml" in drawn && drawn.mathml.startsWith("<math"), JSON.stringify(drawn));
  assertStringIncludes(drawn.mathml, "<mfrac>");
  assertStringIncludes(drawn.mathml, 'display="block"');
  for (
    const tex of [
      "\\href{javascript:alert(1)}{x}",
      "\\url{javascript:alert(1)}",
      "\\htmlClass{evil}{x}",
      "\\htmlStyle{position:fixed}{x}",
      "\\htmlId{app}{x}",
    ]
  ) {
    const out = mathml(temml, tex, false);
    const markup = "mathml" in out ? out.mathml : "";
    assert(!/javascript:|evil|position:fixed|id="app"|<a\b|href/.test(markup), `${tex}: ${markup}`);
  }
  // A macro that never ends, and TeX it can't read, say why.
  assert("error" in mathml(temml, "\\def\\a{\\a\\a}\\a", false));
  assert("error" in mathml(temml, "\\frac{1}{", false));
});
