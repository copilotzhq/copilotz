import assert from "node:assert/strict";
import { mock } from "node:test";
import { Window } from "happy-dom";
import { act, Activity, type ReactNode, useState } from "react";
import { createRuntime, definePlugin, type ViewContext } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../../stores/sql/postgres/mod.ts";
import { tempFile, test } from "../../../testing/mod.ts";
import { ConfirmDialog } from "../toolkit/confirm-dialog.tsx";
import { EntityDialog } from "../toolkit/entity-dialog.tsx";
import { Form, useFormSubmit } from "../toolkit/form.tsx";
import { DateRangePicker } from "../toolkit/date-picker.tsx";
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

test("an entity saves a named control after its part normalizes it", () =>
  page(async (render) => {
    const saved: unknown[] = [];
    function Name() {
      useFormSubmit((form) => {
        form.querySelector<HTMLInputElement>('input[name="name"]')!.value = "normalized";
      });
      return <input name="name" defaultValue="original" />;
    }
    await render(
      <EntityDialog title="Edit" onSubmit={(record) => saved.push(record)} onClose={() => {}}>
        <Name />
      </EntityDialog>,
    );
    await submit();
    assert.deepEqual(saved, [{ name: "normalized" }]);
  }));

test("an entity reads enabled repeated controls in live order after a remount", () =>
  page(async (render) => {
    const work = Promise.withResolvers<void>();
    const saved: unknown[] = [];
    await render(
      <EntityDialog title="Tags" onSubmit={(record) => saved.push(record)} onClose={() => {}}>
        {({ saving }) => (
          <>
            <div key={String(saving)}>
              <input name="tag" defaultValue={saving ? "updated" : "original"} />
              <input name="tag" defaultValue="another" />
              {saving && <input name="tag" defaultValue="disabled" disabled />}
              {!saving && <input name="removed" defaultValue="detached" />}
            </div>
            <Upload wait={work.promise} />
          </>
        )}
      </EntityDialog>,
    );
    await submit();
    await act(async () => work.resolve());
    assert.deepEqual(saved, [{ tag: ["updated", "another"], file: "A.pdf" }]);
  }));

test("an entity saves its latest draft when a part finishes", () =>
  page(async (render) => {
    const work = Promise.withResolvers<void>();
    const saved: unknown[] = [];
    await render(
      <EntityDialog
        title="Edit"
        values={{ qty: 1 }}
        onSubmit={(record) => saved.push(record)}
        onClose={() => {}}
      >
        {({ values, set }) => (
          <>
            <button type="button" id="qty" onClick={() => set({ qty: 2 })}>
              {String(values.qty)}
            </button>
            <Upload wait={work.promise} />
          </>
        )}
      </EntityDialog>,
    );
    await submit();
    await act(() => document.querySelector<HTMLButtonElement>("#qty")!.click());
    assert.equal(document.querySelector("#qty")!.textContent, "2");
    await act(async () => work.resolve());
    assert.deepEqual(saved, [{ qty: 2, file: "A.pdf" }]);
  }));

test("a reconnected Activity form retries while its aborted part is still pending", () =>
  page(async (render) => {
    const first = Promise.withResolvers<void>();
    const retry = Promise.withResolvers<void>();
    const changes: boolean[] = [];
    const saves: string[] = [];
    const signals: AbortSignal[] = [];
    function Attachment({ wait }: { wait: Promise<void> }) {
      useFormSubmit(async (form, signal) => {
        signals.push(signal);
        const file = form.querySelector<HTMLInputElement>('[name="file"]')!;
        await wait;
        if (signal.aborted) return;
        if (wait === first.promise) file.value = "stale.pdf";
        return { file: file.value };
      });
      return <input name="file" defaultValue="old.pdf" />;
    }
    const show = (mode: "visible" | "hidden", wait: Promise<void>) =>
      render(
        <Activity mode={mode}>
          <Form
            onSubmittingChange={(busy) => changes.push(busy)}
            onSubmit={(values, form) => {
              saves.push(String(values.file), form.querySelector("input")!.value);
            }}
          >
            <Attachment wait={wait} />
          </Form>
        </Activity>,
      );
    const busy = () => document.querySelector("form")!.getAttribute("aria-busy");
    await show("visible", first.promise);
    await submit();
    assert.equal(busy(), "true");
    await show("hidden", first.promise);
    await show("visible", retry.promise);
    assert.equal(busy(), null);
    const file = document.querySelector("input")!;
    await typeInto(file, "new.pdf");
    await submit();
    assert.deepEqual(signals.map((s) => s.aborted), [true, false]);
    await act(async () => first.resolve());
    assert.equal(file.value, "new.pdf");
    assert.equal(busy(), "true");
    assert.deepEqual(saves, []);
    await act(async () => retry.resolve());
    assert.equal(busy(), null);
    assert.deepEqual(saves, ["new.pdf", "new.pdf"]);
    assert.deepEqual(changes, [true, false, true, false]);
  }));

test("removing a form during an upload releases its parent's busy state once", () =>
  page(async (render) => {
    const upload = Promise.withResolvers<void>();
    const changes: boolean[] = [];
    const parent = (open: boolean) => (
      <main>
        {open && (
          <Form onSubmittingChange={(busy) => changes.push(busy)}>
            <Upload wait={upload.promise} />
          </Form>
        )}
      </main>
    );
    await render(parent(true));
    await submit();
    assert.deepEqual(changes, [true]);
    await render(parent(false));
    assert.deepEqual(changes, [true, false]);
    await act(async () => upload.resolve());
    assert.deepEqual(changes, [true, false]);
  }));

test("the submit helper flushes the form's completion inside act", () =>
  page(async (render) => {
    await render(<EntityDialog title="Edit" onClose={() => {}} onSubmit={() => false} />);
    const errors = mock.method(console, "error");
    try {
      await submit();
      assert.equal(document.querySelector("form")!.hasAttribute("aria-busy"), false);
      assert.equal(errors.mock.callCount(), 0);
    } finally {
      errors.mock.restore();
    }
  }));

test("an attachment in flight belongs to the dialog that started it", () =>
  page(async (render) => {
    const upload = Promise.withResolvers<void>();
    const saves: unknown[] = [];
    const closed: string[] = [];
    const edit = (id: string) =>
      render(
        <EntityDialog
          title={id}
          values={{ _id: id }}
          onSubmit={(values) => saves.push([id, values])}
          onClose={() => closed.push(id)}
        >
          <Upload wait={upload.promise} />
        </EntityDialog>,
      );
    await edit("A");
    await submit();
    const busy = document.querySelector<HTMLButtonElement>("footer button")!.disabled;
    await edit("B");
    await act(async () => upload.resolve());
    assert.deepEqual({ saves, closed, busy }, { saves: [], closed: [], busy: true });
    assert.equal(document.querySelector<HTMLButtonElement>("footer button")!.disabled, false);
  }));

test("a dismissed save cannot close the next dialog when it finishes", () =>
  page(async (render) => {
    const save = Promise.withResolvers<void>();
    const closed: string[] = [];
    const signals: AbortSignal[] = [];
    const edit = (id: string, open = true) =>
      render(
        <EntityDialog
          title={id}
          open={open}
          values={{ _id: id }}
          onSubmit={(_record, _form, _unset, signal) => {
            signals.push(signal);
            return save.promise;
          }}
          onClose={() => closed.push(id)}
        />,
      );
    await edit("A");
    await submit();
    assert.equal(document.querySelector("dialog")?.getAttribute("aria-busy"), "true");
    await edit("A", false);
    assert.equal(signals[0].aborted, true);
    await edit("B");
    await act(async () => save.resolve());
    assert.deepEqual(closed, []);
  }));

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

test("a new values object without an id starts a fresh draft and cancels the old upload", () =>
  page(async (render) => {
    const work = Promise.withResolvers<void>();
    const saved: unknown[] = [];
    const signals: AbortSignal[] = [];
    function Part() {
      useFormSubmit(async (_form, signal) => {
        signals.push(signal);
        await work.promise;
      });
      return null;
    }
    const edit = (values: { name: string }) =>
      render(
        <EntityDialog
          title="Edit"
          values={values}
          fields={[{ name: "name", label: "Name" }]}
          onClose={() => {}}
          onSubmit={(record) => saved.push(record)}
        >
          <Part />
        </EntityDialog>,
      );
    await edit({ name: "A" });
    await typeInto(document.querySelector("input")!, "edited A");
    await submit();
    await edit({ name: "B" });
    assert.equal(signals[0].aborted, true);
    assert.equal(document.querySelector("input")!.value, "B");
    await act(async () => work.resolve());
    assert.deepEqual(saved, []);
    await submit();
    assert.deepEqual(saved, [{ name: "B" }]);
  }));

test("a reopened confirmation owns its completion and close callback", () =>
  page(async (render) => {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const closed: string[] = [];
    const show = (title: string, operation: Promise<void>, open = true) =>
      render(
        <ConfirmDialog
          title={title}
          open={open}
          onConfirm={() => operation}
          onClose={() => closed.push(title)}
        />,
      );
    const answer = () =>
      act(() => document.querySelector<HTMLButtonElement>("footer button:last-child")!.click());
    await show("A", first.promise);
    await answer();
    await show("A", first.promise, false);
    await show("B", second.promise);
    await answer();
    await act(async () => first.resolve());
    assert.deepEqual(closed, []);
    assert.equal(document.querySelector("dialog")!.getAttribute("aria-busy"), "true");
    await act(async () => second.resolve());
    assert.deepEqual(closed, ["B"]);
  }));

test("reopening or replacing a record clears its inline refusals", () =>
  page(async (render) => {
    const edit = (id: string, open = true) =>
      render(
        <EntityDialog
          title={id}
          open={open}
          values={{ _id: id }}
          fields={[{ name: "email", label: "Email" }]}
          onClose={() => {}}
          onSubmit={() => {
            throw Object.assign(new Error("Email refused"), { detail: { field: "email" } });
          }}
        />,
      );
    await edit("A");
    await submit();
    assert.match(document.body.textContent!, /Email refused/);
    await edit("A", false);
    await edit("A");
    assert.doesNotMatch(document.body.textContent!, /Email refused/);
    await submit();
    await edit("B");
    assert.doesNotMatch(document.body.textContent!, /Email refused/);
  }));

test("applying a compact From date keeps the range end", () =>
  page(async (render) => {
    const applied: unknown[] = [];
    await render(
      <DateRangePicker
        format="yyMMdd"
        value={{ start: "2026-11-01", end: "2026-11-30" }}
        onChange={(range) => applied.push(range)}
      />,
    );
    const from = document.querySelector<HTMLInputElement>(".copilotz-date-end input")!;
    await typeInto(from, "261112");
    assert.equal(from.hasAttribute("aria-invalid"), false);
    document.querySelector<HTMLElement>("[popover]")!.hidePopover = () => {};
    const apply = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent === "Apply"
    );
    await act(() => apply!.click());
    assert.deepEqual(applied, [{ start: "2026-11-12", end: "2026-11-30" }]);
  }));

for (const [locale, input] of [["zh-CN", "2026/211月"], ["ko-KR", "2026/211월"]]) {
  test(
    "a range keeps its dates after an invalid compact month in " + locale,
    () =>
      page(async (render) => {
        document.documentElement.lang = locale;
        const original = { start: "2026-11-01", end: "2026-11-30" };
        const applied: unknown[] = [];
        await render(
          <DateRangePicker
            format="yyyy/dMMM"
            value={original}
            onChange={(range) => applied.push(range)}
          />,
        );
        const from = document.querySelector<HTMLInputElement>(".copilotz-date-end input")!;
        await typeInto(from, input);
        assert.equal(from.getAttribute("aria-invalid"), "true");
        document.querySelector<HTMLElement>("[popover]")!.hidePopover = () => {};
        const apply = Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent === "Apply"
        );
        await act(() => apply!.click());
        assert.deepEqual(applied, [original]);
      }),
  );
}

test("typing dates in a timed range preserves the separate time fields to the second", () =>
  page(async (render) => {
    document.documentElement.lang = "fa-IR";
    const applied: unknown[] = [];
    await render(
      <DateRangePicker
        seconds
        format="dd/MM/yyyy HH:mm:ss"
        value={{ start: "2026-11-01 08:15:20", end: "2026-11-30 18:30:45" }}
        onChange={(range) => applied.push(range)}
      />,
    );
    const [from, to] = document.querySelectorAll<HTMLInputElement>(
      ".copilotz-date-end-input input",
    );
    await typeInto(from, "۱۱/۰۸/۱۴۰۵");
    assert.equal(from.getAttribute("aria-invalid"), "true");
    await typeInto(from, "02/11/2026");
    await typeInto(to, "29/11/2026");
    document.querySelector<HTMLElement>("[popover]")!.hidePopover = () => {};
    const apply = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent === "Apply"
    );
    await act(() => apply!.click());
    assert.deepEqual(applied, [{ start: "2026-11-02 08:15:20", end: "2026-11-29 18:30:45" }]);
  }));

for (const locale of ["en-US", "th-TH", "fa-IR"]) {
  test(
    "a timed range preserves its ends after pasting a whole day-time in " + locale,
    () =>
      page(async (render) => {
        document.documentElement.lang = locale;
        const value = { start: "2026-11-02 14:30", end: "2026-11-03 15:45" };
        const applied: unknown[] = [];
        await render(
          <DateRangePicker
            time
            separator=" → "
            value={value}
            onChange={(range) => applied.push(range)}
          />,
        );
        const ends = document.querySelector(".copilotz-date-field-text")!.textContent!.split(" → ");
        const inputs = document.querySelectorAll<HTMLInputElement>(
          ".copilotz-date-end-input input",
        );
        assert.equal(inputs.length, 2);
        for (const [index, input] of Array.from(inputs).entries()) {
          await typeInto(input, ends[1 - index]);
          assert.equal(input.getAttribute("aria-invalid"), "true");
        }
        document.querySelector<HTMLElement>("[popover]")!.hidePopover = () => {};
        const apply = Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent === "Apply"
        );
        await act(() => apply!.click());
        assert.deepEqual(applied, [value]);
      }),
  );
}

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

const items = (_: unknown, ctx: ViewContext) => ctx.db.collection("item");
for (
  const [name, make] of Object.entries({
    memory: memoryStore,
    sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
    pglite: () => postgresStore({ url: ":memory:" }),
  })
) {
  test("clearing a stored optional price removes it on " + name, async () => {
    const store = await make();
    const runtime = await createRuntime({
      store,
      plugins: [definePlugin({
        name: "items",
        collections: {
          item: {
            schema: {
              type: "object",
              properties: { price: { type: "number" }, name: { type: "string" } },
              additionalProperties: false,
            },
          },
        },
        guard: (_actor, { collection }) => collection === "item" ? {} : undefined,
        views: { items },
      })],
    });
    try {
      const view = runtime.observe<ReturnType<typeof items>>("items", {}, {
        actor: { kind: "person", id: "ana" },
      });
      const ready = await view.ready;
      assert(ready.status === "ready");
      const collection = ready.value;
      const { insertedId } = await collection.insertOne({ price: 24, name: "Pen" });
      let save: Promise<unknown> | undefined;
      await page(async (render) => {
        await render(
          <EntityDialog
            title="Pen"
            values={{ _id: insertedId, price: 24, name: "Pen" }}
            fields={[{ name: "price", label: "Price", type: "number" }]}
            onSubmit={(record, _form, unset) => {
              save = collection.updateOne({ _id: insertedId }, { $set: record, $unset: unset });
              return save;
            }}
            onClose={() => {}}
          />,
        );
        const input = document.querySelector<HTMLInputElement>('input[name="price"]')!;
        await typeInto(input, "");
        await submit();
        assert(save, "Save was submitted");
        await act(async () => {
          await save;
        });
        assert.deepEqual(await store.findOne("item", { _id: insertedId }), {
          _id: insertedId,
          name: "Pen",
        });
      });
    } finally {
      await runtime.close();
    }
  });
}
