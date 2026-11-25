import assert from "node:assert/strict";
import { page } from "./page.ts";
import { act, useState } from "react";
import { test } from "../../../testing/mod.ts";
import { tablePdf } from "../export.ts";
import { Form, useFormSubmit } from "../toolkit/form.tsx";
import { DataTable } from "../toolkit/data-table.tsx";

const submit = () => act(async () => document.querySelector("form")!.requestSubmit());

/** Change the control as typing does, before React handles the input event. */
function typeInto(input: HTMLInputElement, value: string) {
  return act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

function Upload({ wait }: { wait: Promise<void> }) {
  useFormSubmit(async () => {
    await wait;
    return { file: "A.pdf" };
  });
  return null;
}

// The same two submissions on rc.63 (2383779c) read quantity 2, then 3, in both handlers.
test("rc.63 Form parity: later parts and the final save read state when they run", () =>
  page(async (render) => {
    const saved: unknown[] = [];
    function Quantity({ qty }: { qty: number }) {
      useFormSubmit(() => ({ part: qty }));
      return null;
    }
    function Editor({ wait }: { wait: Promise<void> }) {
      const [qty, setQty] = useState(1);
      return (
        <Form
          onSubmit={(parts, form) => saved.push([parts, qty, form.querySelector("input")!.value])}
        >
          <Upload wait={wait} />
          <Quantity qty={qty} />
          <input value={qty} onChange={(event) => setQty(Number(event.target.value))} />
        </Form>
      );
    }
    for (const next of [2, 3]) {
      const work = Promise.withResolvers<void>();
      await render(<Editor wait={work.promise} />);
      await submit();
      await typeInto(document.querySelector("input")!, String(next));
      await act(async () => work.resolve());
    }
    assert.deepEqual(saved, [
      [{ file: "A.pdf", part: 2 }, 2, "2"],
      [{ file: "A.pdf", part: 3 }, 3, "3"],
    ]);
  }));

test("positional PDF widths follow the columns in each downloaded invoice", () =>
  page(async (render) => {
    await render(
      <DataTable
        columns={[
          { key: "warehouse", title: "Warehouse", hidden: true },
          { key: "qty", title: "Qty" },
          { key: "amount", title: "Amount" },
          { key: "memo", title: "Memo" },
        ]}
        rows={[{ warehouse: "W", qty: 2, amount: "1234.56", memo: "M" }]}
        rowKey={() => 1}
        exports={["pdf"]}
        tableExportOptions={{
          pdf: { columns: [{ width: 16 }, { width: 80 }, { width: 100 }, { width: 50 }] },
        }}
      />,
    );
    let url = "";
    document.addEventListener("click", (event) => {
      if (event.target instanceof window.HTMLAnchorElement) {
        event.preventDefault();
        url = event.target.href;
      }
    });
    document.querySelector<HTMLElement>('[role="menu"]')!.hidePopover = () => {};
    const toggle = (index: number) =>
      act(() =>
        document.querySelectorAll<HTMLInputElement>(".copilotz-table-columns input")[index].click()
      );
    const amountAt = async (x: number) => {
      await act(() => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
      const pdf = await (await fetch(url)).text();
      for (const value of ["Amount", "1234.56"]) {
        assert.ok(
          pdf.split("\n").some((line) =>
            line.includes(`Tf ${x} `) && line.endsWith(`(${value}) Tj ET`)
          ),
          value,
        );
      }
      url = "";
    };
    await amountAt(55); // Warehouse starts hidden. Qty gets 16 points.
    await toggle(0);
    await amountAt(135); // Warehouse, Qty, Amount.
    await toggle(1);
    await amountAt(55); // Hide the middle Qty column.
    await toggle(3);
    await amountAt(55); // Qty and Memo both hidden.
  }));

test("unknown export choices warn once and stay out of the menu on re-render", () =>
  page(async (render) => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
      for (const label of ["Orders", "Invoices"]) {
        await render(
          <DataTable
            label={label}
            columns={[]}
            rows={[]}
            rowKey={() => 1}
            exportChoices={["missing", { format: "toString", label: "Broken" }, "missing", {
              format: "csv",
              label: "Save CSV",
            }]}
          />,
        );
        assert.deepEqual(
          Array.from(document.querySelectorAll('[role="menuitem"]'), (el) => el.textContent),
          ["Save CSV"],
        );
      }
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /missing, toString/);
    } finally {
      console.warn = warn;
    }
  }));

test("hiding sales columns keeps PDF widths and alignment with their fields", () =>
  page(async (render) => {
    await render(
      <DataTable
        columns={[
          { key: "id", title: "ID", hidden: true },
          { key: "qty", title: "Qty" },
          { key: "product", title: "Product" },
        ]}
        rows={[{ id: "7", qty: "2", product: "Coffee" }]}
        rowKey={(row) => row.id}
        footerRows={[{ product: "Total" }]}
        exports={["pdf"]}
        tableExportOptions={{
          pdf: {
            columns: {
              id: { width: 14 },
              qty: { width: 45, align: "right" },
              product: { width: 120 },
            },
          },
        }}
      />,
    );
    let url = "";
    document.addEventListener("click", (event) => {
      if (event.target instanceof window.HTMLAnchorElement) {
        event.preventDefault();
        url = event.target.href;
      }
    });
    document.querySelector<HTMLElement>('[role="menu"]')!.hidePopover = () => {};
    const toggle = (index: number) =>
      act(() =>
        document.querySelectorAll<HTMLInputElement>(".copilotz-table-columns input")[index].click()
      );
    const check = async (showId: boolean, showQty: boolean) => {
      await act(() => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
      const pdf = await (await fetch(url)).text();
      assert.ok(pdf.includes("(Coffee) Tj"));
      assert.ok(pdf.includes("(Total) Tj"));
      assert.equal(pdf.includes("(7) Tj"), showId);
      assert.equal(pdf.includes("(2) Tj"), showQty);
      // 36-point margin, the visible preceding widths, and 3 points of cell padding.
      const productX = 36 + (showId ? 14 : 0) + (showQty ? 45 : 0) + 3;
      assert.match(pdf, new RegExp(productX + " [\\d.]+ Td \\(Coffee\\)"));
      if (showQty) assert.match(pdf, /Tf 73 [\d.]+ Td \(2\)/); // right-aligned in 45 points
      url = "";
    };
    await check(false, true);
    await toggle(0);
    await toggle(1);
    await check(true, false);
    await toggle(0);
    await check(false, false);
  }));

test("a table with rc.63 props downloads the automatic PDF even with aligned screen columns", () =>
  page(async (render) => {
    const options = { pdf: { title: "Purchasing", titleLines: [123], columns: "app-owned" } };
    await render(
      <DataTable
        columns={[{ key: "order", title: "Order" }, { key: "qty", title: "Qty", align: "right" }]}
        rows={[{ order: "PO-42", qty: 9 }]}
        rowKey={(row) => row.order}
        exports={["pdf"]}
        exportOptions={options}
      />,
    );
    let url = "";
    document.addEventListener("click", (event) => {
      if (event.target instanceof window.HTMLAnchorElement) {
        event.preventDefault();
        url = event.target.href;
      }
    });
    document.querySelector<HTMLElement>('[role="menu"]')!.hidePopover = () => {};
    await act(() => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
    const expected = tablePdf({ headers: ["Order", "Qty"], rows: [["PO-42", "9"]] }, {
      title: "Purchasing",
    });
    assert.deepEqual(new Uint8Array(await (await fetch(url)).arrayBuffer()), expected);
  }));
