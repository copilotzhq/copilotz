import assert from "node:assert/strict";
import { mock } from "node:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { createRuntime, definePlugin, type ViewContext } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../../stores/sql/postgres/mod.ts";
import { tempFile, test } from "../../../testing/mod.ts";
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
    const edit = (id: string) =>
      render(
        <EntityDialog
          title={id}
          values={{ _id: id }}
          onSubmit={() => save.promise}
          onClose={() => closed.push(id)}
        />,
      );
    await edit("A");
    await submit();
    assert.equal(document.querySelector("dialog")?.getAttribute("aria-busy"), "true");
    await edit("B");
    await act(async () => save.resolve());
    assert.deepEqual(closed, []);
  }));

test("a form captures its callbacks before awaiting its first part", () =>
  page(async (render) => {
    const upload = Promise.withResolvers<void>();
    const ran: string[] = [];
    function Part({ name }: { name: string }) {
      useFormSubmit(() => {
        ran.push(name);
      });
      return null;
    }
    const show = (name: string) =>
      render(
        <Form onSubmit={() => ran.push("save " + name)}>
          <Upload wait={upload.promise} />
          <Part name={name} />
        </Form>,
      );
    await show("first");
    await submit();
    await show("second");
    await act(async () => upload.resolve());
    assert.deepEqual(ran, ["first", "save first"]);
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

test("a range accepts its displayed English time to the second in From", () =>
  page(async (render) => {
    await render(
      <DateRangePicker
        label="Range"
        separator=" → "
        seconds
        value={{
          start: "2026-11-16 10:00:00",
          end: "2026-11-16 13:00:00",
        }}
        onChange={() => {}}
      />,
    );
    const shown = document.querySelector(".copilotz-date-field-text")!.textContent!;
    const end = shown.split(" → ")[1];
    const input = document.querySelector<HTMLInputElement>(".copilotz-date-end input")!;
    await typeInto(input, end);
    assert.equal(input.value, end);
    assert.equal(input.hasAttribute("aria-invalid"), false);
    assert.equal(
      document.querySelector<HTMLInputElement>('.copilotz-date-end input[role="spinbutton"]')!
        .value,
      "13",
    );
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
