/**
 * Contacts (people outside the org, writing on a line) are let into nothing of
 * billing's: what the org has to spend, and paying for it, are its people's.
 */
import { assertEquals } from "@std/assert";
import { openTo, test } from "copilotz/testing";
import { credits, stripe, stripeWebhook } from "../mod.ts";

test("no Action, query or event of credits' or Stripe's is open to a contact", () => {
  assertEquals(openTo({ kind: "contact", id: "c-someone" }, [credits, stripe, stripeWebhook]), []);
});
