/**
 * Contacts (people outside the org, writing on a line) are let into nothing of
 * work's: boards and documents are the org's people's and their agents'.
 */
import { assertEquals } from "@std/assert";
import { openTo, test } from "copilotz/testing";
import { boards, documents } from "../mod.ts";

test("no Action, query or event of boards' or documents' is open to a contact", () => {
  assertEquals(openTo({ kind: "contact", id: "c-someone" }, [boards, documents]), []);
});
