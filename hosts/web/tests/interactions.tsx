import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { act, type ReactNode, useState } from "react";
import { test } from "../../../testing/mod.ts";
import { Form, useFormSubmit } from "../toolkit/form.tsx";
import { DataTable } from "../toolkit/data-table.tsx";

async function page(run: (render: (node: ReactNode) => Promise<void>) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.body.appendChild(document.createElement("main")));
  try {
    await run(async (node) => {
      await act(() => root.render(node));
    });
  } finally {
    await act(() => root.unmount());
    await window.happyDOM.close();
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

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

test("table PDF settings follow the visible export columns", () =>
  page(async (render) => {
    let options: unknown;
    await render(
      <DataTable
        columns={[
          { key: "secret", title: "Secret", hidden: true },
          { key: "name", title: "Name" },
          { key: "total", title: "Total" },
        ]}
        rows={[]}
        rowKey={() => 1}
        exports={["pdf"]}
        exportOptions={{ pdf: { columns: [{ width: 110 }, { align: "right" }] } }}
        formats={{
          pdf: {
            label: "PDF",
            type: "application/pdf",
            extension: "pdf",
            serialize: (_sheet, _name, given) => {
              options = given.pdf?.columns;
              return "";
            },
          },
        }}
      />,
    );
    document.querySelector<HTMLElement>('[role="menu"]')!.hidePopover = () => {};
    document.addEventListener("click", (event) => event.preventDefault());
    await act(() => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
    assert.deepEqual(options, [{ align: undefined, width: 110 }, { align: "right" }]);
  }));
