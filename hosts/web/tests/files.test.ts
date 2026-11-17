/** Which files a file field takes, by its `accept` as the browser reads it, and which dropped ones it keeps. */
import { assert, assertEquals } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import { accepts, keptOf } from "../toolkit/files.ts";

const csv = { name: "Clientes.CSV", type: "" };
const png = { name: "foto.png", type: "image/png" };
const pdf = { name: "nota.pdf", type: "application/pdf" };

test("accept: extensions whatever their case, exact types, a kind of type, or anything", () => {
  assert(accepts(csv, ".csv,text/csv"));
  assert(accepts(png, "image/*"));
  assert(accepts(pdf, " application/pdf , .txt"));
  assert(!accepts(png, ".csv"));
  assert(!accepts(pdf, "image/*"));
  assert(accepts(pdf));
  assert(accepts(pdf, ""));
});

test("dropped files: those it takes, only the first unless multiple", () => {
  assertEquals(keptOf([png, csv, pdf], ".csv,.pdf"), [csv]);
  assertEquals(keptOf([png, csv, pdf], ".csv,.pdf", true), [csv, pdf]);
  assertEquals(keptOf([png], ".csv"), []);
});
