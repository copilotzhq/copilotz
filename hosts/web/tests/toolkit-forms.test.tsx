/**
 * The toolkit's form pieces and surfaces, as they draw (React, rendered to
 * markup): buttons in every fill and size, icons by name or the app's own,
 * inputs with addons joined to them, radios, fields stacked or in a row and
 * marked required, dialogs that keep focus on themselves near the top, cards
 * with a heading, and a class name on menus and suggestion lists. And the
 * rule their looks keep: a piece's own token always has its default where
 * it's used, and a theme's token never does.
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../testing/mod.ts";
import { DEFAULT_THEME } from "../theme/default.ts";
import { Autocomplete } from "../toolkit/autocomplete.tsx";
import { Button } from "../toolkit/button.tsx";
import { Card } from "../toolkit/card.tsx";
import { Dialog } from "../toolkit/dialog.tsx";
import { Field } from "../toolkit/field.tsx";
import { Icon } from "../toolkit/icon.tsx";
import { Input } from "../toolkit/input.tsx";
import { Menu } from "../toolkit/menu.tsx";
import { Radio } from "../toolkit/radio.tsx";
import { Tabs } from "../toolkit/tabs.tsx";

/** What a piece draws, without its stylesheets. */
const html = (node: ReactNode) =>
  renderToStaticMarkup(<>{node}</>).replace(/<style[\s\S]*?<\/style>/g, "");

const GLYPH = { viewBox: "0 0 16 16", paths: [{ d: "M1 1h14v14H1z", rule: "evenodd" as const }] };

test("buttons: a status's solid fill, an extra-small size, as wide as their box", () => {
  for (const variant of ["success", "info", "warning"] as const) {
    assertStringIncludes(html(<Button variant={variant}>Go</Button>), `copilotz-button-${variant}`);
  }
  const small = html(<Button size="xs" block>Paid</Button>);
  assertStringIncludes(small, "copilotz-button-xs");
  assertStringIncludes(small, "copilotz-button-block");
  // The default size and look say nothing more than they did.
  assertEquals(
    html(<Button>Go</Button>),
    '<button type="button" class="copilotz-button copilotz-button-outline">Go</button>',
  );
});

test("icons: the toolkit's by name, an app's drawing or image, or any element of its own", () => {
  assertMatch(
    html(<Button icon="share">Share</Button>),
    /<svg class="copilotz-icon"[^>]*viewBox="0 0 24 24"/,
  );
  const drawn = html(<Button icon={<Icon drawing={GLYPH} />}>Sales</Button>);
  assertStringIncludes(drawn, 'viewBox="0 0 16 16"');
  assertStringIncludes(drawn, 'fill-rule="evenodd"');
  assertStringIncludes(drawn, 'fill="currentColor"');
  const image = html(<Icon src="/assets/modules/sales.png" size={24} label="Sales" />);
  assertStringIncludes(image, '<img class="copilotz-icon" src="/assets/modules/sales.png"');
  assertStringIncludes(image, 'alt="Sales"');
  assertStringIncludes(html(<Icon src="/a.png" />), 'aria-hidden="true"');
  const own = html(<Button iconEnd={<b className="mine">$</b>}>Pay</Button>);
  assertStringIncludes(own, 'Pay<b class="mine">$</b>');
  assertStringIncludes(
    html(
      <Tabs
        label="T"
        value="a"
        onChange={() => {}}
        tabs={[{ value: "a", label: "A", icon: <i>★</i> }]}
      />,
    ),
    "<i>★</i>A",
  );
});

test("inputs: addons outside the box and joined to it; the group takes the class", () => {
  const plain = html(<Input className="wide" />);
  assert(!plain.includes("copilotz-input-group"));
  assertMatch(plain, /^<span class="copilotz-input wide"/);
  const money = html(<Input addon="$" addonEnd="%" className="wide" size="sm" />);
  assertMatch(
    money,
    /^<span class="copilotz-input-group copilotz-input-group-sm wide"><span class="copilotz-input-addon">\$<\/span><span class="copilotz-input copilotz-input-sm"[^>]*><input\/><\/span><span class="copilotz-input-addon">%<\/span><\/span>$/,
  );
});

test("radios: the browser's own, labelled", () => {
  assertEquals(
    html(<Radio name="plan" value="year" label="Yearly" defaultChecked />),
    '<label class="copilotz-radio"><input type="radio" name="plan" checked="" value="year"/><span>Yearly</span></label>',
  );
});

test("fields: required said and shown, a row beside the label, the control as it is", () => {
  const stacked = html(
    <Field label="Name" required hint="As on the card">
      {(control) => <input {...control} />}
    </Field>,
  );
  assertStringIncludes(stacked, '<span class="copilotz-field-mark" aria-hidden="true">*</span>');
  assertStringIncludes(stacked, '<span class="copilotz-sr">, required</span>');
  assertMatch(stacked, /<input id="([^"]+)" aria-describedby="\1-note"\/>/);
  assert(!stacked.includes("copilotz-field-row"));

  const row = html(
    <Field
      layout="row"
      label="Email"
      htmlFor="email"
      error="Not an address"
      labelWidth="25%"
      controlWidth="66%"
    >
      <input id="email" />
    </Field>,
  );
  assertStringIncludes(row, 'class="copilotz-field copilotz-field-row"');
  assertStringIncludes(row, 'data-invalid="true"');
  assertStringIncludes(row, "--field-row-label-width:25%");
  assertStringIncludes(row, "--field-row-control-width:66%");
  assertStringIncludes(row, '<label class="copilotz-field-label" for="email">Email</label>');
  assertMatch(
    row,
    /<div class="copilotz-field-control"><input id="email"\/><p id="[^"]+-note" class="copilotz-field-note copilotz-field-error">Not an address<\/p><\/div>/,
  );
});

test("dialogs: near the top, and focus on the dialog itself when asked", () => {
  const top = html(
    <Dialog open onClose={() => {}} title="Edit" placement="top" focus="dialog">x</Dialog>,
  );
  assertMatch(top, /<dialog class="copilotz-dialog copilotz-dialog-top" tabindex="-1"/);
  const plain = html(<Dialog open onClose={() => {}} title="Edit">x</Dialog>);
  assertMatch(plain, /<dialog class="copilotz-dialog" aria-labelledby=/);
});

test("cards: a heading with an icon and an action, padding the body's", () => {
  const panel = html(
    <Card title="Reports" icon="chart" action={<button type="button">All</button>} padding="none">
      <ul />
    </Card>,
  );
  assertMatch(
    panel,
    /^<div class="copilotz-card"><div class="copilotz-card-head"><svg[^>]*>.*<\/svg><h3 class="copilotz-card-title">Reports<\/h3><div class="copilotz-card-action"><button type="button">All<\/button><\/div><\/div><div class="copilotz-card-body"><ul><\/ul><\/div><\/div>$/,
  );
  assertStringIncludes(
    html(<Card title="Totals" level={2}>9</Card>),
    '<h2 class="copilotz-card-title">Totals</h2></div><div class="copilotz-card-body copilotz-card-md">9</div>',
  );
  assertEquals(html(<Card>9</Card>), '<div class="copilotz-card copilotz-card-md">9</div>');
});

test("menus and suggestion lists take a class for their box", () => {
  assertMatch(
    html(<Menu label="More" items={[{ label: "Share" }]} className="mine" />),
    /role="menu" aria-label="More" class="copilotz-menu copilotz-anchored mine"/,
  );
  assertMatch(
    html(
      <Autocomplete
        id="l"
        target={{ current: null }}
        open={false}
        label="People"
        options={[]}
        active={0}
        onActive={() => {}}
        onPick={() => {}}
        className="mine"
      />,
    ),
    /class="copilotz-autocomplete copilotz-anchored mine"/,
  );
});

/** The theme's own tokens: those it sets (light), its radii and its fonts. */
const THEME_TOKENS = new Set([
  ...Object.keys(DEFAULT_THEME.light ?? {}),
  ...Object.keys(DEFAULT_THEME.dark ?? {}),
  "radius",
  "font-sans",
  "font-display",
  "font-mono",
]);
const isTheme = (name: string) => THEME_TOKENS.has(name) || /^radius-/.test(name);
/** A piece's own variables, set on the element itself (a badge's tone): not tokens. */
const isLocal = (name: string) => /^tone(-|$)/.test(name);

test("a piece's own token always has its default where it's used; a theme's never does", () => {
  const pieces = [
    "button",
    "icon-button",
    "input",
    "select",
    "textarea",
    "checkbox",
    "radio",
    "field",
    "dialog",
    "tabs",
    "menu",
    "popover",
    "autocomplete",
    "badge",
    "notice",
    "card",
    "tooltip",
  ];
  for (const piece of pieces) {
    const source = readFileSync(new URL(`../toolkit/${piece}.tsx`, import.meta.url), "utf8");
    for (const [, name, comma] of source.matchAll(/var\(--([a-z0-9-]+)\s*(,?)/g)) {
      if (isLocal(name)) continue;
      if (isTheme(name)) assertEquals(comma, "", `${piece}: the theme's --${name} has a fallback`);
      else assertEquals(comma, ",", `${piece}: --${name} is used without its default`);
    }
  }
});
