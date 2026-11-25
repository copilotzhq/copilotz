/**
 * What the dialogs do, apart from how they draw: a confirm runs what it confirms busy, and a
 * failure keeps its words with the dialog open; `confirm()` asks from anywhere where `<Toasts />`
 * is, one question at a time, and answers once; a record's form reads its named controls as a
 * record keeps them, makes its numbers numbers, leaves `_id` out and says which needed fields are
 * empty before anything is sent.
 */
import { assertEquals, assertRejects } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import { askedNow, confirm, type Confirming, runConfirm } from "../toolkit/confirm-state.ts";
import { entityValues, formValues } from "../toolkit/form-values.ts";
import { mountToasts } from "../toolkit/toast-state.ts";

test("a confirm is busy while it runs, then done", async () => {
  const states: Confirming[] = [];
  let ran = 0;
  const done = await runConfirm(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      ran++;
    },
    (state) => states.push(state),
    "It wasn't done.",
  );
  assertEquals(done, true);
  assertEquals(ran, 1);
  assertEquals(states, [{ busy: true }, { busy: false }]);
});

test("a failed confirm keeps its error to show, and isn't done (the dialog stays open)", async () => {
  const states: Confirming[] = [];
  const failed = await runConfirm(
    () => Promise.reject(new Error("That customer has open invoices.")),
    (state) => states.push(state),
    "It wasn't done.",
  );
  assertEquals(failed, false);
  assertEquals(states, [{ busy: true }, {
    busy: false,
    error: "That customer has open invoices.",
  }]);
  // A failure with no words of its own says the toolkit's.
  const quiet: Confirming[] = [];
  assertEquals(
    await runConfirm(() => Promise.reject(new Error("")), (s) => quiet.push(s), "No."),
    false,
  );
  assertEquals(quiet.at(-1), { busy: false, error: "No." });
  // Nothing to run: confirming is all it asks.
  assertEquals(await runConfirm(undefined, () => {}, "No."), true);
});

test("confirm() asks where <Toasts /> is, one question at a time, and answers once", async () => {
  await assertRejects(() => confirm({ title: "Delete it?" }), Error, "<Toasts />");
  const unmount = mountToasts("page-toasts", false);
  try {
    const first = confirm({ title: "Delete Ana?", danger: true });
    const second = confirm({ title: "Delete Bo?", danger: true });
    assertEquals(askedNow().map((a) => a.options.title), ["Delete Ana?", "Delete Bo?"]);
    askedNow()[0].answer(true);
    assertEquals(await first, true);
    assertEquals(askedNow().map((a) => a.options.title), ["Delete Bo?"]);
    const bo = askedNow()[0];
    bo.answer(false);
    bo.answer(true); // answered already: nothing changes
    assertEquals(await second, false);
    assertEquals(askedNow(), []);
  } finally {
    unmount();
  }
});

/** A form's elements, as `form.elements` lists them. */
const form = (...elements: Record<string, unknown>[]) => ({ elements });

test("a form's named controls, as a record keeps them", () => {
  assertEquals(
    formValues(form(
      { name: "name", type: "text", value: "Ana" },
      { name: "price", type: "number", value: "12.5", valueAsNumber: 12.5 },
      { name: "stock", type: "number", value: "", valueAsNumber: NaN },
      { name: "vip", type: "checkbox", checked: true, value: "on" },
      { name: "archived", type: "checkbox", checked: false, value: "on" },
      { name: "size", type: "radio", checked: false, value: "s" },
      { name: "size", type: "radio", checked: true, value: "m" },
      { name: "tags", type: "checkbox", checked: true, value: "new" },
      { name: "tags", type: "checkbox", checked: false, value: "old" },
      { name: "tags", type: "checkbox", checked: true, value: "sale" },
      { name: "rooms", type: "select-multiple", selectedOptions: [{ value: "a" }, { value: "c" }] },
      { name: "notes", type: "textarea", value: "Line 1\nLine 2" },
      { name: "", type: "text", value: "no name" },
      { name: "secret", type: "text", value: "x", disabled: true },
      { name: "go", type: "submit", value: "Save" },
      { name: "picture", type: "file", value: "C:\\fakepath\\a.png" },
    )),
    {
      name: "Ana",
      price: 12.5,
      vip: true,
      archived: false,
      size: "m",
      tags: ["new", "sale"],
      rooms: ["a", "c"],
      notes: "Line 1\nLine 2",
    },
  );
});

test("a record ready to save: numbers as numbers, no _id, and the needed fields left empty", () => {
  const fields = [
    { name: "name", required: true },
    { name: "price", type: "number", required: true },
    { name: "stock", type: "number" },
    { name: "since", type: "date", required: true },
    { name: "vip", type: "checkbox", required: true },
  ];
  assertEquals(
    entityValues(fields, {
      _id: "c1",
      name: "Ana",
      price: "12.50",
      stock: "",
      since: "2026-11-16",
      vip: false,
      in: "space-1",
    }),
    {
      values: { name: "Ana", price: 12.5, since: "2026-11-16", vip: false, in: "space-1" },
      missing: [],
    },
  );
  assertEquals(
    entityValues(fields, { name: "  ", price: "", since: undefined }).missing,
    ["name", "price", "since"],
  );
  // Text that isn't a number stays as it is, for the schema to refuse by its field.
  assertEquals(entityValues(fields, { name: "Ana", price: "twelve" }).values.price, "twelve");
});
