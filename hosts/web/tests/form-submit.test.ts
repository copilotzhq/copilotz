/**
 * A form's submit with parts: each part's handler in the order it joined,
 * values handed up to the form's own, and a part that stops it (`false`, or
 * a throw with words to say) stopping what comes after. A failure about one
 * field says which, and goes under the field that holds it.
 */
import { assertEquals } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import { fieldFor, fieldOf, submitAll, wordsOf } from "../toolkit/form-submit.ts";

const form = {} as HTMLFormElement;

test("every part, in order, then the form's own with what they handed up", async () => {
  const ran: string[] = [];
  const done = await submitAll(form, [
    () => {
      ran.push("tab");
    },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      ran.push("packages");
      return { packages: [{ name: "Gold" }] };
    },
    () => ({ points: 10 }),
  ], (values) => {
    ran.push(`own ${Object.keys(values).join(",")}`);
  });
  assertEquals(ran, ["tab", "packages", "own packages,points"]);
  assertEquals(done, { ok: true, values: { packages: [{ name: "Gold" }], points: 10 } });
});

test("a part that says no stops the save: false says nothing, a throw fails, with its words", async () => {
  const saved: string[] = [];
  const own = () => {
    saved.push("own");
  };
  assertEquals(await submitAll(form, [() => false, () => ({ late: 1 })], own), { ok: false });
  assertEquals(
    await submitAll(form, [() => {
      throw new Error("A package needs a name.");
    }], own),
    { ok: false, failed: true, error: "A package needs a name." },
  );
  assertEquals(
    await submitAll(form, [], () => Promise.reject(new Error("Couldn't save"))),
    { ok: false, failed: true, error: "Couldn't save" },
  );
  // A failure with no words still fails: the form says it wasn't saved.
  assertEquals(
    await submitAll(form, [() => {
      throw new Error("");
    }], own),
    { ok: false, failed: true },
  );
  assertEquals(saved, []);
});

test("a failure's words: a message, a string, or none", () => {
  assertEquals(wordsOf(new Error(" Too long ")), "Too long");
  assertEquals(wordsOf("No"), "No");
  assertEquals(wordsOf({ message: "From a failure" }), "From a failure");
  assertEquals(wordsOf(42), undefined);
  assertEquals(wordsOf(new Error("")), undefined);
});

test("a failure about one field says which: a schema's refusal, or an Action's with a detail", async () => {
  // As a save the schema refuses rejects in the browser: its words, and the field in `detail`.
  const refused = Object.assign(new Error("customer: must match pattern (#/email)"), {
    code: "invalid",
    detail: { field: "email" },
  });
  assertEquals(await submitAll(form, [], () => Promise.reject(refused)), {
    ok: false,
    failed: true,
    error: "customer: must match pattern (#/email)",
    field: "email",
  });
  assertEquals(fieldOf({ detail: { field: "lines.0.quantity" } }), "lines.0.quantity");
  assertEquals(fieldOf({ detail: { field: "" } }), undefined);
  assertEquals(fieldOf(new Error("No")), undefined);
  assertEquals(fieldOf(null), undefined);
});

test("a refusal goes under the field that holds it: itself, or the nearest it's part of", () => {
  const shown = ["name", "lines", "address", "address.city"];
  assertEquals(fieldFor("name", shown), "name");
  assertEquals(fieldFor("lines.0.quantity", shown), "lines");
  assertEquals(fieldFor("address.city", shown), "address.city");
  assertEquals(fieldFor("address.street", shown), "address");
  // None shows it (nor a field whose name only starts the same): the form says it at its top.
  assertEquals(fieldFor("names", shown), undefined);
  assertEquals(fieldFor("price", []), undefined);
});
