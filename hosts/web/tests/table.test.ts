/**
 * A data table's rows, apart from drawing them: search finds every word in
 * any titled column, accents and case aside, never in a column of links;
 * sorting is by text in the language's order (numbers in it by value) or by
 * number; paging, the page links and the page sizes worth offering.
 */
import { assertEquals } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import {
  type Column,
  fold,
  onPage,
  pageCount,
  pageLinks,
  pageOf,
  searchRows,
  sizesFor,
  sortedBy,
  sortRows,
  type TableState,
  tableView,
  textOf,
} from "../toolkit/table.ts";

type Row = { id: number; name: string; city: string; price: number; priceText: string };

const rows: Row[] = [
  { id: 1, name: "João Silva", city: "São Paulo", price: 1234.5, priceText: "R$ 1.234,50" },
  { id: 2, name: "Ann Lee", city: "Lisbon", price: 9.9, priceText: "R$ 9,90" },
  { id: 3, name: "Item 10", city: "Porto", price: 100, priceText: "R$ 100,00" },
  { id: 4, name: "Item 2", city: "Paris", price: -5, priceText: "-R$ 5,00" },
];

const columns: Column<Row>[] = [
  { key: "name", title: "Name" },
  { key: "city", title: "City" },
  { key: "price", title: "Price", numeric: true, text: (r) => r.priceText },
  { key: "edit", title: "", render: () => null, text: () => "joao edit link" },
];

const state = (more: Partial<TableState> = {}): TableState => ({
  search: "",
  order: "asc",
  offset: 0,
  limit: 25,
  ...more,
});

test("search: every word, in any titled column, accents and case aside", () => {
  assertEquals(fold("São JOÃO"), "sao joao");
  assertEquals(searchRows(rows, columns, "joao").map((r) => r.id), [1]);
  assertEquals(searchRows(rows, columns, "  silva   paulo ").map((r) => r.id), [1]);
  assertEquals(searchRows(rows, columns, "item p").map((r) => r.id), [3, 4]);
  assertEquals(searchRows(rows, columns, "").length, 4);
  // Never in a column of links.
  assertEquals(searchRows(rows, columns, "edit").length, 0);
});

test("sorting: text in order with numbers by value, numbers by the row's value", () => {
  const name = columns[0];
  assertEquals(sortRows(rows, name, "asc", "en").map((r) => r.name), [
    "Ann Lee",
    "Item 2",
    "Item 10",
    "João Silva",
  ]);
  assertEquals(sortRows(rows, columns[2], "desc").map((r) => r.id), [1, 3, 2, 4]);
  // Without a number in the row, the number in the text.
  const plain: Column<{ t: string }> = { key: "t", title: "T", numeric: true };
  assertEquals(
    sortRows([{ t: "$1,200" }, { t: "$90" }, { t: "-3" }], plain, "asc").map((r) => r.t),
    ["-3", "$90", "$1,200"],
  );
  assertEquals(textOf({ key: "missing", title: "M" }, { other: 1 }), "");
});

test("the view: searched, sorted, paged; unpaged gives every row", () => {
  const view = tableView(rows, columns, state({ sort: "price", order: "asc", limit: 2 }));
  assertEquals(view.page.map((r) => r.id), [4, 2]);
  assertEquals(view.total, 4);
  assertEquals(view.matching.length, 4);
  assertEquals(tableView(rows, columns, state({ offset: 2, limit: 2 })).page.map((r) => r.id), [
    3,
    4,
  ]);
  assertEquals(tableView(rows, columns, state({ limit: 1 }), { paged: false }).page.length, 4);
  // A column of links isn't sorted by.
  assertEquals(tableView(rows, columns, state({ sort: "edit" })).page.map((r) => r.id), [
    1,
    2,
    3,
    4,
  ]);
});

test("a header sorts ascending, then the other way, back on the first page", () => {
  const once = sortedBy(state({ offset: 50 }), "name");
  assertEquals([once.sort, once.order, once.offset], ["name", "asc", 0]);
  assertEquals(sortedBy(once, "name").order, "desc");
  assertEquals(sortedBy(sortedBy(once, "name"), "city").order, "asc");
});

test("pages: counted, current, kept in range, and the links with their gaps", () => {
  assertEquals(pageCount(0, 25), 1);
  assertEquals(pageCount(80, 25), 4);
  assertEquals(pageOf(state({ offset: 50 })), 3);
  assertEquals(onPage(state(), 9, 80).offset, 75);
  assertEquals(onPage(state(), 0, 80).offset, 0);
  assertEquals(pageLinks(1, 5), [1, 2, 3, 4, 5]);
  assertEquals(pageLinks(1, 20), [1, 2, 3, 4, 5, "gap", 20]);
  assertEquals(pageLinks(10, 20), [1, "gap", 8, 9, 10, 11, 12, "gap", 20]);
  assertEquals(pageLinks(20, 20), [1, "gap", 16, 17, 18, 19, 20]);
  assertEquals(pageLinks(4, 9), [1, 2, 3, 4, 5, 6, "gap", 9]);
});

test("page sizes: those that show fewer than all, the first that shows all, and the one in use", () => {
  assertEquals(sizesFor([10, 25, 50, 100], 30, 25), [10, 25, 50]);
  assertEquals(sizesFor([10, 25, 50, 100], 8, 25), [10, 25]);
  assertEquals(sizesFor([100, 10, 10], 500, 30), [10, 30, 100]);
});
