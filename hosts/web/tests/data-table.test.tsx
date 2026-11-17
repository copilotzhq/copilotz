/**
 * A data table as the page draws it: sortable headers that say how they're
 * sorted, a column of links named for screen readers, a box to tick per row
 * only when there are actions, the page of rows and the pages under it, what
 * it says when empty or loading, and widths from its columns (no CSS of the
 * screen's). And a server-paged table's state, read from the address and
 * written back to it with the address's other keys.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../testing/mod.ts";
import { tableQuery, tableState } from "../table-address.ts";
import { type Column, DataTable } from "../toolkit/data-table.tsx";
import { Pagination } from "../toolkit/pagination.tsx";

type Row = { id: number; name: string; total: number };

const rows: Row[] = Array.from({ length: 30 }, (_, i) => ({
  id: i + 1,
  name: `Customer ${i + 1}`,
  total: i * 10,
}));

const columns: Column<Row>[] = [
  { key: "name", title: "Name" },
  { key: "total", title: "Total", numeric: true, align: "right", width: 120, nowrap: true },
  { key: "secret", title: "Secret", hidden: true },
  { key: "edit", title: "", label: "Edit", render: (r) => <a href={`/c/${r.id}`}>edit</a> },
];

const html = (node: React.ReactNode) =>
  renderToStaticMarkup(<>{node}</>).replace(/<style[\s\S]*?<\/style>/g, "");

const count = (text: string, part: string) => text.split(part).length - 1;

test("headers sort and say so; a column of links is named; hidden columns don't show", () => {
  const page = html(
    <DataTable
      label="Customers"
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      state={{ search: "", sort: "total", order: "desc", offset: 0, limit: 25 }}
      onState={() => {}}
    />,
  );
  assertStringIncludes(page, 'aria-label="Customers"');
  assertStringIncludes(page, 'aria-sort="descending"');
  assertEquals(count(page, 'class="copilotz-table-sort"'), 2);
  assertStringIncludes(page, '<span class="copilotz-sr">Edit</span>');
  assert(!page.includes('data-field="secret"'));
  assertStringIncludes(page, 'style="width:120px"');
  assertStringIncludes(page, "copilotz-table-right copilotz-table-number copilotz-table-nowrap");
  // Sorted by total, descending, paged: Customer 30 first, 25 rows.
  assert(page.indexOf("Customer 30") < page.indexOf("Customer 29"));
  assertEquals(count(page, "data-row"), 25);
  assertStringIncludes(page, "Showing 1 to 25 of 30 rows");
  assertStringIncludes(page, 'aria-current="page"');
});

test("a box per row only with actions; the actions are given the ticked rows", () => {
  const without = html(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
  assert(!without.includes("Select all rows"));
  let given: unknown;
  const withActions = html(
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      actions={(ticked) => {
        given = ticked;
        return <button type="button">Delete</button>;
      }}
    />,
  );
  assertStringIncludes(withActions, 'aria-label="Select all rows"');
  assertEquals(count(withActions, 'aria-label="Select this row"'), 25);
  assertStringIncludes(withActions, ">Delete</button>");
  assertEquals(given, []);
});

test("on the server, the rows given are the page, and the count is the total's", () => {
  const page = html(
    <DataTable
      columns={columns}
      rows={rows.slice(0, 3)}
      total={300}
      rowKey={(r) => r.id}
      state={{ search: "", order: "asc", offset: 25, limit: 25 }}
      onState={() => {}}
      exports={false}
    />,
  );
  assertEquals(count(page, "data-row"), 3);
  assertStringIncludes(page, "Showing 26 to 50 of 300 rows");
  assertStringIncludes(page, 'aria-label="Page 12"');
  assert(!page.includes(">Export<"));
});

test("empty, loading, and a detail button per row", () => {
  assertStringIncludes(
    html(<DataTable columns={columns} rows={[]} rowKey={(r) => r.id} empty="No customers yet" />),
    "No customers yet",
  );
  assertStringIncludes(
    html(<DataTable columns={columns} rows={[]} rowKey={(r) => r.id} />),
    "Nothing to show",
  );
  const loading = html(<DataTable columns={columns} rows={[]} rowKey={(r) => r.id} loading />);
  assertStringIncludes(loading, "Loading…");
  assertStringIncludes(loading, 'aria-busy="true"');
  const detail = html(
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      detail={(r) => <p>{r.name}</p>}
    />,
  );
  assertEquals(count(detail, 'aria-label="Show details"'), 25);
  assertStringIncludes(detail, 'aria-expanded="false"');
});

test("the export menu lists its formats; the toolbar and pages can go", () => {
  const page = html(
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      exports={["csv", { format: "xlsx", label: "Planilha" }]}
    />,
  );
  assertStringIncludes(page, ">CSV<");
  assertStringIncludes(page, ">Planilha<");
  const bare = html(
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      toolbar={false}
      pagination={false}
    />,
  );
  assert(!bare.includes("copilotz-table-toolbar"));
  assert(!bare.includes("copilotz-pagination"));
  assertEquals(count(bare, "data-row"), 30);
});

test("pagination alone: no links for one page, no size choice when sizes are off", () => {
  const one = html(
    <Pagination
      total={8}
      state={{ search: "", order: "asc", offset: 0, limit: 25 }}
      onState={() => {}}
    />,
  );
  assertStringIncludes(one, "Showing 1 to 8 of 8 rows");
  assert(!one.includes("copilotz-pagination-links"));
  const fixed = html(
    <Pagination
      total={80}
      state={{ search: "", order: "asc", offset: 75, limit: 25 }}
      onState={() => {}}
      sizes={false}
    />,
  );
  assert(!fixed.includes("rows per page"));
  assertStringIncludes(fixed, 'aria-label="Next page" disabled=""');
});

test("the address holds a table's state, beside its other keys", () => {
  const where = {
    path: "/customers",
    query: {
      search: "ann",
      sort: "name",
      order: "desc",
      offset: "25",
      limit: "50",
      from: "2026-01-01",
    },
  };
  assertEquals(tableState(where, 25), {
    search: "ann",
    sort: "name",
    order: "desc",
    offset: 25,
    limit: 50,
  });
  assertEquals(tableState({ path: "/", query: { limit: "-4", offset: "x" } }, 25), {
    search: "",
    order: "asc",
    offset: 0,
    limit: 25,
  });
  assertEquals(tableState({ path: "/", query: { limit: "99999" } }, 25).limit, 1000);
  assertEquals(
    tableQuery(where, { search: "bo", order: "asc", offset: 0, limit: 25 }),
    "?from=2026-01-01&search=bo&limit=25",
  );
  assertEquals(tableQuery(where, undefined, { from: undefined, to: "x" }).includes("from="), false);
  assertEquals(tableQuery({ path: "/" }), "");
});

test("detail rows: closed at first, open always (no button), or open per row", () => {
  const some = rows.slice(0, 3);
  const detail = (r: Row) => <b>more {r.id}</b>;
  const base = { columns, rows: some, rowKey: (r: Row) => r.id, detail, pagination: false };
  const closed = html(<DataTable {...base} />);
  assertEquals(count(closed, "copilotz-table-expand"), 3);
  assertEquals(count(closed, "<b>more"), 0);
  const always = html(<DataTable {...base} detailOpen />);
  assertEquals(count(always, "copilotz-table-expand"), 0);
  assertEquals(count(always, "<b>more"), 3);
  const some1 = html(<DataTable {...base} detailOpen={(r) => r.id === 2} />);
  assertEquals(count(some1, "<b>more"), 1);
  assertEquals(count(some1, 'aria-expanded="true"'), 1);
  assertEquals(count(some1, "copilotz-table-expand"), 3);
});

test("a fixed layout is a class; the scroll box is the positioned one and cell fields shrink", () => {
  const fixed = html(
    <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} layout="fixed" />,
  );
  assertStringIncludes(fixed, "copilotz-table-grid copilotz-table-fixed");
  assert(
    !html(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />).includes("-fixed"),
  );
  const css = readFileSync(
    fileURLToPath(new URL("../toolkit/data-table.tsx", import.meta.url)),
    "utf8",
  );
  assertStringIncludes(css, ".copilotz-table-box { position: relative; overflow-x: auto;");
  assertStringIncludes(css, "width: 100%; min-width: 0; }");
  assertStringIncludes(css, "table-layout: fixed");
});
