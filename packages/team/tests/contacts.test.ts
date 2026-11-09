/**
 * Contacts (people outside the org, writing on a line) are let into nothing of
 * team's or tiers': agents and their models are the org's people's to make
 * and choose.
 */
import { assertEquals } from "@std/assert";
import { openTo, test } from "copilotz/testing";
import { team, tiers } from "../mod.ts";

test("no Action, query or event of team's or tiers' is open to a contact", () => {
  assertEquals(openTo({ kind: "contact", id: "c-someone" }, [team, tiers]), []);
});
