/**
 * A form its parts join, drawn: a part inside one knows it (and so shows
 * no Submit of its own), one outside knows it's alone. And printing: what
 * a printed page leaves out, the shell's frame too, and an app's own parts
 * marked for paper or for the screen only.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../testing/mod.ts";
import { STYLE as SHELL } from "../../../plugins/interfaces/web/shared/style.ts";
import { BASE } from "../style.ts";
import { Form, useFormState, useFormSubmit } from "../toolkit/form.tsx";
import { NoPrint, PrintOnly } from "../toolkit/print.tsx";

const html = (node: React.ReactNode) =>
  renderToStaticMarkup(<>{node}</>).replace(/<style[\s\S]*?<\/style>/g, "");

/** A part, as another plugin's View would be: it shows its own Submit only outside a form. */
function Panel() {
  const { inForm } = useFormSubmit(() => ({ packages: [] }));
  const { submitting } = useFormState();
  return inForm
    ? <p>joined{submitting ? " saving" : ""}</p>
    : <button type="submit">Save packages</button>;
}

test("a form lays out its children, and a part inside it joins it", () => {
  const form = html(
    <Form id="rewards" aria-label="Rewards" gap="lg" method="post">
      <input name="on" />
      <Panel />
    </Form>,
  );
  assertStringIncludes(
    form,
    '<form id="rewards" aria-label="Rewards" class="copilotz-form copilotz-gap-lg" method="post">',
  );
  assertStringIncludes(form, "<p>joined</p>");
  assert(!form.includes("Save packages"));
  // Outside a form, the part says so, and shows its own Submit.
  assertEquals(html(<Panel />), '<button type="submit">Save packages</button>');
});

test("printing: the base leaves out what's for working the screen, important over the toolkit", () => {
  const print = BASE.slice(BASE.indexOf("@media print"));
  for (
    const left of [
      ".copilotz-no-print",
      ".copilotz-appbar",
      ".copilotz-topbar",
      ".copilotz-toolbar",
      ".copilotz-toasts",
      ".copilotz-table-toolbar",
      ".copilotz-pagination",
      ".copilotz-button",
    ]
  ) assertStringIncludes(print, left);
  assertStringIncludes(print, "display: none !important");
  // The whole page, not a scrolling pane's screenful.
  assertStringIncludes(
    print,
    ".copilotz-page-full { height: auto !important; overflow: visible !important; }",
  );
  assertStringIncludes(
    BASE,
    "@media not print { .copilotz-print-only { display: none !important; } }",
  );
  // The shell's frame doesn't print either.
  const shell = SHELL.slice(SHELL.indexOf("@media print"));
  assertStringIncludes(shell, ".copilotz-shell > .copilotz-sidebar");
  assertStringIncludes(shell, ".copilotz-panel");
});

test("an app's own parts, for the screen only or for paper only", () => {
  assertEquals(html(<NoPrint>keypad</NoPrint>), '<div class="copilotz-no-print">keypad</div>');
  assertEquals(
    html(<PrintOnly as="span" className="x">Printed today</PrintOnly>),
    '<span class="copilotz-print-only x">Printed today</span>',
  );
});
