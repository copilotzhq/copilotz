/**
 * The app's bars, tiles, switches, tags, pickers and barcodes, as React
 * draws them: what's current is said, what's chosen is said, every control
 * is named, and a form gets what they hold.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../testing/mod.ts";
import { AppBar, TopBar } from "../toolkit/app-bar.tsx";
import { Barcode } from "../toolkit/barcode.tsx";
import { Icon } from "../toolkit/icon.tsx";
import { MultiPicker, Picker } from "../toolkit/picker.tsx";
import { Switch } from "../toolkit/switch.tsx";
import { TagsInput } from "../toolkit/tags-input.tsx";
import { TileGrid } from "../toolkit/tile-grid.tsx";
import { Toasts } from "../toolkit/toast.tsx";

/** What it draws, its styles left out. */
const html = (node: React.ReactNode) =>
  renderToStaticMarkup(<>{node}</>).replace(/<style[\s\S]*?<\/style>/g, "");

test("the app bar: the brand home, the places, the active one is the page", () => {
  const bar = html(
    <AppBar
      brand="Acme"
      href="/"
      active="/sales"
      items={[
        { href: "/sales", label: "Sales", icon: <Icon src="/assets/sales.png" /> },
        { href: "/items", label: "Items", icon: "archive", key: "items" },
      ]}
      end={<button type="button">Sign out</button>}
    />,
  );
  assertStringIncludes(bar, '<a class="copilotz-appbar-brand" href="/">Acme</a>');
  assertStringIncludes(bar, '<nav class="copilotz-appbar-nav" aria-label="Navigation">');
  assertStringIncludes(bar, 'href="/sales" aria-current="page"');
  assert(!/href="\/items"[^>]*aria-current/.test(bar));
  // The app's own image, and the toolkit's icon by name.
  assertStringIncludes(bar, 'src="/assets/sales.png"');
  assertEquals((bar.match(/<svg/g) ?? []).length, 1);
  assertStringIncludes(bar, "Sign out");
  assertStringIncludes(html(<AppBar items={[]} layout="stacked" />), 'data-layout="stacked"');
});

test("the top bar's three places, and tiles with what each is for", () => {
  const strip = html(<TopBar start="09:41" center="Acme Stores" end="Ana" />);
  assertStringIncludes(strip, '<div class="copilotz-topbar-start">09:41</div>');
  assertStringIncludes(strip, '<div class="copilotz-topbar-center">Acme Stores</div>');
  const tiles = html(
    <TileGrid
      label="Modules"
      tiles={[{ href: "/sales", label: "Sales", icon: "chart", description: "Sales and returns." }]}
    />,
  );
  assertStringIncludes(tiles, 'aria-label="Modules"');
  const described = tiles.match(/aria-describedby="([^"]+)"/)?.[1];
  assert(described);
  assertStringIncludes(tiles, `id="${described}" class="copilotz-sr">Sales and returns.</span>`);
  assertStringIncludes(tiles, 'title="Sales and returns."');
});

test("toasts: nothing on a page made on the server (they show once mounted)", () => {
  assertEquals(html(<Toasts />), "");
});

test("a switch says whether it's on, and its words for each state", () => {
  const plain = html(<Switch label="Notify me" checked={false} onChange={() => {}} />);
  assertStringIncludes(plain, 'role="switch" aria-checked="false" aria-label="Notify me"');
  const worded = html(
    <Switch label="Type" checked on="$" off="%" joined="end" onChange={() => {}} />,
  );
  assertStringIncludes(worded, 'aria-checked="true"');
  assertStringIncludes(worded, 'data-joined="end"');
  assertStringIncludes(worded, '<span class="copilotz-switch-word">$</span>');
  assert(!worded.includes(">%<"));
});

test("tags: each with its remove button, and the field named; a form gets them", () => {
  const tags = html(
    <TagsInput label="Formats" name="formats" values={["EAN13", "UPC-A"]} onChange={() => {}} />,
  );
  assertStringIncludes(tags, 'aria-label="Remove EAN13"');
  assertStringIncludes(tags, 'aria-label="Remove UPC-A"');
  assertStringIncludes(tags, 'aria-label="Formats"');
  assertStringIncludes(tags, '<input type="hidden" name="formats" value="EAN13,UPC-A"/>');
});

const MODES = [{ value: "sale", label: "Sale" }, { value: "return", label: "Return" }];

test("a picker shows what's chosen, marks it in its list, and sends it with a form", () => {
  const picker = html(
    <Picker label="Mode" name="mode" value="return" options={MODES} onChange={() => {}} />,
  );
  assertStringIncludes(picker, 'aria-haspopup="listbox"');
  assertStringIncludes(picker, '<span class="copilotz-picker-text">Return</span>');
  assertStringIncludes(picker, 'role="listbox" aria-label="Mode"');
  assert(/aria-selected="true"[^>]*>.*?<span>Return<\/span>/.test(picker));
  assertStringIncludes(picker, '<input type="hidden" name="mode" value="return"/>');
  // Nothing chosen: its placeholder, quiet; with search, a box over the list.
  const empty = html(
    <Picker
      label="Customer"
      search
      placeholder="Anyone"
      value={undefined}
      options={MODES}
      onChange={() => {}}
    />,
  );
  assertStringIncludes(empty, 'data-empty="true">Anyone</span>');
  assertStringIncludes(empty, 'type="search"');
});

test("a multiple picker says none, the one, or how many", () => {
  const say = (values: string[]) =>
    html(<MultiPicker label="Types" values={values} options={MODES} onChange={() => {}} />)
      .match(/<span class="copilotz-picker-text"[^>]*>([^<]*)<\/span>/)?.[1];
  assertEquals(say([]), "None chosen");
  assertEquals(say(["sale"]), "Sale");
  assertEquals(say(["sale", "return"]), "2 chosen");
  assertStringIncludes(
    html(
      <MultiPicker label="Types" values={[]} none="[Select]" options={MODES} onChange={() => {}} />,
    ),
    "[Select]",
  );
  assertStringIncludes(
    html(<MultiPicker label="Types" values={["sale"]} options={MODES} onChange={() => {}} />),
    'aria-multiselectable="true"',
  );
});

test("a barcode is a picture named by its value, its caption hidden from readers", () => {
  const code = html(<Barcode value="POS 12" caption />);
  assertStringIncludes(code, 'role="img" aria-label="POS 12"');
  assertStringIncludes(
    code,
    '<span class="copilotz-barcode-caption" aria-hidden="true">POS 12</span>',
  );
  assert(/<path d="M\d+ 0h\d+v50h-\d+z/.test(code));
});

test("Code 128 grows to its minimum width with an omitted or narrow width", () => {
  const value = "A".repeat(25);
  assertStringIncludes(html(<Barcode value={value} />), 'viewBox="0 0 330 50"');
  assertStringIncludes(html(<Barcode value="SKU-12345" width={120} />), 'viewBox="0 0 143 50"');
});
