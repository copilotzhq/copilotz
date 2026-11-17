/**
 * The file field as the page draws it: the browser's own file field (sent with a form, out of the
 * tab order, read by its button instead), a button named by its words or a label, what's chosen
 * said as it changes, and a field a `Field` names by the button's id.
 */
import { assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../testing/mod.ts";
import { Field } from "../toolkit/field.tsx";
import { FileInput } from "../toolkit/file-input.tsx";

const markup = (node: React.ReactNode) =>
  renderToStaticMarkup(<>{node}</>).replace(/<style[\s\S]*?<\/style>/g, "");

test("the native field sends the files: name, accept, multiple, required; out of the tab order", () => {
  const html = markup(<FileInput name="files" accept=".csv" multiple required />);
  assertStringIncludes(html, 'type="file"');
  for (const said of ['name="files"', 'accept=".csv"', 'multiple=""', 'required=""']) {
    assertStringIncludes(html, said);
  }
  assertStringIncludes(html, 'tabindex="-1" aria-hidden="true"');
});

test("its button says what to do, one file or several; what's chosen is a live description", () => {
  assertStringIncludes(markup(<FileInput />), ">Choose a file</button>");
  assertStringIncludes(markup(<FileInput multiple />), ">Choose files</button>");
  const html = markup(<FileInput placeholder="No file yet" />);
  assertStringIncludes(html, 'aria-live="polite"');
  assertStringIncludes(html, ">No file yet</span>");
});

test("a Field's label names its button, and a disabled one can't be used", () => {
  const html = markup(
    <Field label="Customers (CSV)" htmlFor="import">
      <FileInput id="import" accept=".csv" />
    </Field>,
  );
  assertStringIncludes(html, 'for="import"');
  assertStringIncludes(html, 'id="import" class="copilotz-file-input-choose"');
  const off = markup(<FileInput disabled />);
  assertStringIncludes(off, 'data-disabled=""');
  assertStringIncludes(off, 'disabled="" aria-describedby');
});
