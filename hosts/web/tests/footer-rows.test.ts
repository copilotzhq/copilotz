// @ts-nocheck: written as an untyped JavaScript wrapper would call DataTable.
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { test } from "../../../testing/mod.ts";
import { tablePdf } from "../export.ts";
import { loadTsx } from "./load-tsx.ts";
import { page } from "./page.ts";

const { DataTable } = await loadTsx(() => import("../toolkit/data-table.tsx"));

test("a JavaScript wrapper can forward its own footerRows and download the rc.63 PDF", () =>
  page(async (render) => {
    const props = {
      columns: [{ key: "qty", title: "Qty", align: "right" }],
      rows: [{ qty: 9 }],
      rowKey: () => 1,
      exports: ["pdf"],
    };
    await render(createElement(DataTable, props));
    const markup = document.querySelector("table").outerHTML;

    const warnings = [];
    const warn = console.warn;
    try {
      console.warn = (message) => warnings.push(message);
      for (const footerRows of [[{ qty: "Total" }, null], [["other"]], "app-owned"]) {
        await render(createElement(DataTable, { ...props, footerRows }));
        assert.equal(document.querySelector("table").outerHTML, markup);
      }
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(warnings, ["DataTable: footerRows isn't an array of rows; ignored"]);

    let url;
    document.addEventListener("click", (event) => {
      if (event.target instanceof window.HTMLAnchorElement) {
        event.preventDefault();
        url = event.target.href;
      }
    });
    document.querySelector('[role="menu"]').hidePopover = () => {};
    await act(() => document.querySelector('[role="menuitem"]').click());
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    assert.deepEqual(bytes, tablePdf({ headers: ["Qty"], rows: [["9"]] }));
  }));
