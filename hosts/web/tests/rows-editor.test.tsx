/**
 * The rows editor as the page draws it: each row numbered (or named by the app), its fields a
 * group named by its number, its add-after and remove buttons named by the row, an error under a
 * row's fields that describes them, the bounds disabling the buttons, and "Add a row" at the end.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../testing/mod.ts";
import { Input } from "../toolkit/input.tsx";
import { RowsEditor } from "../toolkit/rows-editor.tsx";

const markup = (node: React.ReactNode) =>
  renderToStaticMarkup(<>{node}</>).replace(/<style[\s\S]*?<\/style>/g, "");
const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;

type Code = { code: string; name: string };
const codes: Code[] = [{ code: "A", name: "Alpha" }, { code: "", name: "Beta" }];
const fields = (row: Code) => <Input aria-label="Code" value={row.code} onChange={() => {}} />;

test("rows numbered, each a named group of fields with its own buttons", () => {
  const html = markup(
    <RowsEditor
      label="Tax codes"
      rows={codes}
      onChange={() => {}}
      make={() => ({ code: "", name: "" })}
      render={fields}
    />,
  );
  assertStringIncludes(html, 'role="group" aria-label="Tax codes"');
  assertStringIncludes(html, ">Row 1</span>");
  assertStringIncludes(html, ">Row 2</span>");
  assertStringIncludes(html, 'aria-label="Add a row after row 2"');
  assertStringIncludes(html, 'aria-label="Remove row 1"');
  assertStringIncludes(html, ">Add a row</button>");
  assertEquals2(count(html, /role="group" aria-labelledby=/g), 2);
});

test("a row's error under its fields, describing them; the app's names for its rows", () => {
  const html = markup(
    <RowsEditor
      rows={codes}
      onChange={() => {}}
      make={() => ({ code: "", name: "" })}
      render={fields}
      rowLabel={(_, i) => `Tax code ${i + 1}`}
      error={(row) => (row.code ? undefined : "Give the code.")}
    />,
  );
  assertStringIncludes(html, ">Tax code 2</span>");
  assertEquals2(count(html, /data-invalid=""/g), 1);
  assertStringIncludes(html, 'class="copilotz-rows-error">Give the code.</p>');
  const described = /aria-describedby="([^"]+)"/.exec(html)?.[1];
  assert(described && html.includes(`id="${described}" class="copilotz-rows-error"`));
});

test("the bounds: no add at max, no remove at min; with no rows, only the add button", () => {
  const full = markup(
    <RowsEditor
      rows={codes}
      onChange={() => {}}
      make={() => ({ code: "", name: "" })}
      render={fields}
      min={2}
      max={2}
    />,
  );
  assert(!full.includes(">Add a row</button>"));
  assertEquals2(count(full, /disabled=""/g), 4);
  const empty = markup(
    <RowsEditor
      rows={[]}
      onChange={() => {}}
      make={() => ({ code: "", name: "" })}
      render={fields}
      addLabel="Add a tax code"
    />,
  );
  assert(!empty.includes("<ol"));
  assertStringIncludes(empty, ">Add a tax code</button>");
});

function assertEquals2(actual: number, expected: number) {
  assert(actual === expected, `${actual} isn't ${expected}`);
}

test("no add buttons, and the remove control's icon and words are the app's", () => {
  const html = markup(
    <RowsEditor
      rows={codes}
      onChange={() => {}}
      make={() => ({ code: "", name: "" })}
      render={fields}
      add={false}
      removeIcon="close"
      removeLabel={(_, i) => `Drop line ${i + 1}`}
    />,
  );
  assert(!html.includes("copilotz-rows-add"));
  assert(!html.includes("Add a row"));
  assert(!html.includes("Add a row after"));
  assertStringIncludes(html, 'aria-label="Drop line 2"');
  assertEquals(count(html, /Drop line/g), 2);
  assertStringIncludes(
    markup(
      <RowsEditor
        rows={codes}
        onChange={() => {}}
        make={() => codes[0]}
        render={fields}
        removeLabel="Delete"
      />,
    ),
    'aria-label="Delete"',
  );
});
