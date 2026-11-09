/**
 * Contacts (people outside the org, writing on a line) are let into nothing of
 * the directory's, nor of what each org's runtime gets of it.
 */
import { assertEquals } from "@std/assert";
import { openTo, test } from "copilotz/testing";
import { directory } from "../mod.ts";

test("no Action, query or event of the directory's is open to a contact", () => {
  assertEquals(openTo({ kind: "contact", id: "c-someone" }, [directory]), []);
});
