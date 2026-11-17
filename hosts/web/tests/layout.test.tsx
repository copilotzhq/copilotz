/**
 * The layout pieces a screen is made of without CSS: what each draws, with
 * its steps of the spacing scale, its columns, and what screen readers hear.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../testing/mod.ts";
import { columnsOf, Grid, GridItem } from "../toolkit/grid.tsx";
import { Icon } from "../toolkit/icon.tsx";
import { ListGroup } from "../toolkit/list-group.tsx";
import { Split } from "../toolkit/split.tsx";
import { Divider, Spacer, Stack } from "../toolkit/stack.tsx";
import { Heading, Text } from "../toolkit/text.tsx";
import { Toolbar } from "../toolkit/toolbar.tsx";

/** A piece's markup, its stylesheets taken out. */
const html = (node: React.ReactNode) =>
  renderToStaticMarkup(<>{node}</>).replace(/<style[\s\S]*?<\/style>/g, "");

test("a stack: a column by default, spaced md; a row aligned, wrapping; another element", () => {
  assertEquals(
    html(<Stack>a</Stack>),
    '<div class="copilotz-stack copilotz-gap-md">a</div>',
  );
  assertEquals(
    html(<Stack direction="row" gap="xs" align="center" justify="between" wrap>a</Stack>),
    '<div class="copilotz-stack copilotz-stack-row copilotz-stack-wrap copilotz-gap-xs ' +
      'copilotz-align-center copilotz-justify-between">a</div>',
  );
  const form = html(<Stack as="form" id="item" aria-label="Item">a</Stack>);
  assertStringIncludes(form, '<form id="item" aria-label="Item" class="copilotz-stack');
  assertStringIncludes(
    html(
      <Stack direction="row">
        <Spacer />
        <Divider />
      </Stack>,
    ),
    "<hr",
  );
  assertStringIncludes(html(<Spacer />), 'aria-hidden="true"');
});

test("a grid's columns: equal ones, a template, or as many as fit", () => {
  assertEquals(columnsOf(3, undefined), "repeat(3, minmax(0, 1fr))");
  assertEquals(columnsOf(undefined, undefined), "repeat(2, minmax(0, 1fr))");
  assertEquals(columnsOf("1fr 2fr", undefined), "1fr 2fr");
  assertEquals(columnsOf(3, "220px"), "repeat(auto-fill, minmax(min(220px, 100%), 1fr))");
  assertEquals(columnsOf(0, undefined), "repeat(1, minmax(0, 1fr))");
});

test("a grid collapses when narrow (sm by default), never as many-as-fit, and spans", () => {
  const two = html(<Grid columns={2}>a</Grid>);
  assertStringIncludes(two, 'class="copilotz-grid copilotz-gap-md copilotz-grid-collapse-sm"');
  assertStringIncludes(two, "--copilotz-grid-columns:repeat(2, minmax(0, 1fr))");
  assert(!html(<Grid min="200px">a</Grid>).includes("collapse"));
  assert(!html(<Grid columns={2} collapse={false}>a</Grid>).includes("collapse"));
  assertStringIncludes(html(<GridItem span={2}>a</GridItem>), "--copilotz-grid-span:2");
});

test("a toolbar: its groups, and a group's name only when it has one", () => {
  const bar = html(<Toolbar start={<b>new</b>} end={<i>search</i>} label="Items" />);
  assertStringIncludes(bar, 'role="group" aria-label="Items"');
  assertStringIncludes(bar, '<div class="copilotz-toolbar-group copilotz-gap-sm"><b>new</b></div>');
  assertStringIncludes(bar, "copilotz-toolbar-end");
  assert(!html(<Toolbar start="a" />).includes("role="));
});

test("a split: the main column and the aside, named; sides, widths and stacking", () => {
  const split = html(<Split aside="sum" label="Summary" sticky>cart</Split>);
  assertStringIncludes(split, "copilotz-split copilotz-split-md copilotz-split-sticky");
  assertStringIncludes(split, '<div class="copilotz-split-main">cart</div>');
  assertStringIncludes(
    split,
    '<aside class="copilotz-split-aside" aria-label="Summary">sum</aside>',
  );
  assertStringIncludes(
    html(<Split aside="a" side="start" width="lg" stacked="aside-first">m</Split>),
    "copilotz-split copilotz-split-lg copilotz-split-start copilotz-split-aside-first",
  );
});

test("a list group: links, actions, plain rows, the current one, and an app's own icon", () => {
  const list = html(
    <ListGroup
      label="Reports"
      items={[
        { href: "/a", label: "Sales", description: "By day", active: true, end: "3" },
        { label: "Run", onSelect: () => {}, icon: "play" },
        { label: "Taxes", icon: <Icon src="/assets/tax.png" /> },
        { href: "/b", label: "Off", disabled: true },
      ]}
    />,
  );
  assertStringIncludes(list, '<ul class="copilotz-list-group" aria-label="Reports">');
  assertStringIncludes(list, '<a class="copilotz-list-group-row" href="/a" aria-current="page">');
  assertStringIncludes(list, '<span class="copilotz-list-group-description">By day</span>');
  assertStringIncludes(list, '<button type="button" class="copilotz-list-group-row">');
  assertStringIncludes(list, 'src="/assets/tax.png"');
  assertStringIncludes(list, '<a class="copilotz-list-group-row" aria-disabled="true">');
  // A row's end is beside its link, so a button there is never inside it.
  assertStringIncludes(list, '</a><span class="copilotz-list-group-end">3</span></li>');
  const remove = html(
    <ListGroup
      items={[{ key: "red", label: "Red", end: <button type="button">Remove</button> }]}
    />,
  );
  assertStringIncludes(
    remove,
    '</div><span class="copilotz-list-group-end"><button type="button">Remove</button></span>',
  );
  assertStringIncludes(html(<ListGroup flush items={[]} />), "copilotz-list-group-flush");
});

test("text and headings: tones, sizes, weights, and the heading's level and size", () => {
  assertEquals(
    html(<Text as="p" tone="muted" size="sm" weight="bold" align="end" mono>x</Text>),
    '<p class="copilotz-text copilotz-text-sm copilotz-text-muted copilotz-text-bold ' +
      'copilotz-text-end copilotz-text-mono">x</p>',
  );
  assertEquals(html(<Text>x</Text>), '<span class="copilotz-text">x</span>');
  assertEquals(
    html(<Heading>x</Heading>),
    '<h2 class="copilotz-heading copilotz-heading-2">x</h2>',
  );
  assertEquals(
    html(<Heading level={1} size={3} id="t">x</Heading>),
    '<h1 id="t" class="copilotz-heading copilotz-heading-3">x</h1>',
  );
});

test("hidden reaches the element of every layout piece, and the base hides what carries it", async () => {
  const { BASE } = await import("../style.ts");
  assertStringIncludes(html(<Stack hidden>a</Stack>), "hidden");
  assertStringIncludes(html(<Grid hidden>a</Grid>), 'hidden=""');
  assertStringIncludes(BASE, ':where([class*="copilotz-"])[hidden] { display: none !important; }');
});

test("new line icons: cart, gift, credit card, piggy bank, tags", async () => {
  const { ICONS } = await import("../toolkit/icon.tsx");
  for (const name of ["cart", "gift", "credit-card", "piggy-bank", "tags"] as const) {
    assert(ICONS.includes(name), name);
    const svg = html(<Icon name={name} />);
    assertStringIncludes(svg, 'viewBox="0 0 24 24"');
    assertStringIncludes(svg, 'stroke-width="1.8"');
  }
});

test("a toolbar's grow item sits between the children and the end, and takes the room", () => {
  const out = html(<Toolbar start="S" grow="G" end="E" />);
  assert(
    out.indexOf("S") < out.indexOf('copilotz-toolbar-grow">G') &&
      out.indexOf("G") < out.indexOf(">E<"),
  );
  assert(!html(<Toolbar start="S" />).includes("copilotz-toolbar-grow"));
});

test("a page: header out of print unless kept, title centred on ask", async () => {
  const { Page } = await import("../toolkit/page.tsx");
  const { BASE } = await import("../style.ts");
  assertStringIncludes(BASE, ".copilotz-page-head:not(.copilotz-page-head-print)");
  assert(!html(<Page title="T">x</Page>).includes("copilotz-page-head-print"));
  assertStringIncludes(
    html(<Page title="T" printHeader>x</Page>),
    'class="copilotz-page-head copilotz-page-head-print"',
  );
  assertStringIncludes(html(<Page title="T" align="center">x</Page>), "copilotz-page-center");
  assert(!html(<Page title="T">x</Page>).includes("copilotz-page-center"));
});

test("a screen: content centred, the footer kept at the foot, inside a route's page", async () => {
  const { Screen } = await import("../toolkit/screen.tsx");
  const { routePageHtml } = await import("../route-page.ts");
  const out = html(<Screen footer="Acme">card</Screen>);
  assertStringIncludes(out, '<div class="copilotz-screen-content">card</div>');
  assertStringIncludes(out, '<footer class="copilotz-screen-footer">Acme</footer>');
  assert(!html(<Screen>card</Screen>).includes("<footer"));
  const page = routePageHtml({} as never, { title: "In", body: <Screen>card</Screen> });
  assertStringIncludes(page, "min-height: 100dvh");
  assertStringIncludes(page, "var(--screen-width, 420px)");
});
