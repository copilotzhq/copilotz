/**
 * Boards' and documents' declarations, as `describe` reads them (`copilotz/describe`): their
 * collections under the access rules, their Actions for people (an agent working for one too,
 * never a contact or someone signed out), their tools for agents, and the listing's rules kept.
 */
import { assert, assertEquals } from "@std/assert";
import { describe } from "copilotz/describe";
import { test } from "copilotz/testing";
import { boards, documents } from "../mod.ts";

test("describe: boards' collections, Actions and tools; listable", async () => {
  const b = await describe(boards);
  assertEquals(b.requires, ["chat", "spaces"]);
  assertEquals(b.keeps.map((c) => [c.name, c.shared]), [["board", true], ["card", true]]);
  for (const a of b.actions) {
    assertEquals(
      [
        a.name,
        a.helper,
        a.callers?.person,
        a.callers?.agent,
        a.callers?.contact,
        a.callers?.anonymous,
      ],
      [a.name, "people", "yes", "yes", "no", "no"],
    );
  }
  assertEquals(b.actions.find((a) => a.name === "card.create")!.tool, "create_card");
  assert(b.tools.some((t) => t.name === "read_board"));
  assertEquals(b.powers, ["guard"]);
  assert(b.listing.listable);
});

test("describe: documents' Actions are people's, and it's listable", async () => {
  const d = await describe(documents);
  assertEquals(d.requires, ["chat", "spaces"]);
  for (const a of d.actions) assertEquals([a.callers?.contact, a.callers?.anonymous], ["no", "no"]);
  assert(d.listing.listable);
});
