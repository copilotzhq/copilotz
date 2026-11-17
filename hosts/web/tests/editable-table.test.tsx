/**
 * A table whose cells are fields (a cart's cost, quantity and discount per line): the fields are
 * drawn in their cells with their names, and a click anywhere in a toolkit field's box, an
 * addon, a tags field or a picker is the field's, never a tick of its row.
 */
import { assert, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../testing/mod.ts";
import { Button } from "../toolkit/button.tsx";
import { DataTable, OWN_CLICK } from "../toolkit/data-table.tsx";
import { Input } from "../toolkit/input.tsx";

type Line = { id: number; name: string; cost: string; quantity: string };
const lines: Line[] = [{ id: 1, name: "Café", cost: "4.50", quantity: "2" }];

test("fields in cells, each named, and a button to send the row", () => {
  const html = renderToStaticMarkup(
    <DataTable
      rows={lines}
      rowKey={(l) => l.id}
      toolbar={false}
      pagination={false}
      columns={[
        { key: "name", title: "Item", sortable: false },
        {
          key: "cost",
          title: "Cost",
          sortable: false,
          render: (l) => <Input size="sm" aria-label="Cost" value={l.cost} onChange={() => {}} />,
        },
        {
          key: "quantity",
          title: "Quantity",
          sortable: false,
          render: (l) => (
            <Input size="sm" aria-label="Quantity" value={l.quantity} onChange={() => {}} />
          ),
        },
        {
          key: "update",
          title: "",
          label: "Update",
          render: () => <Button size="xs">Update</Button>,
        },
      ]}
    />,
  );
  assertStringIncludes(html, 'aria-label="Cost" value="4.50"');
  assertStringIncludes(html, 'aria-label="Quantity" value="2"');
  assertStringIncludes(html, ">Update</button>");
});

test("a click in a toolkit field's box is the field's, not the row's", () => {
  for (
    const own of [
      "input",
      "select",
      "textarea",
      "button",
      "a",
      "label",
      ".copilotz-input",
      ".copilotz-input-group",
      ".copilotz-select",
      ".copilotz-tags-input",
      ".copilotz-file-input",
      ".copilotz-picker",
      "[role=switch]",
      "[role=spinbutton]",
    ]
  ) assert(OWN_CLICK.split(", ").includes(own), own);
});
