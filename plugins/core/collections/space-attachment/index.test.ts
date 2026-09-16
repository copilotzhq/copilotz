import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { spaceAttachmentCollection, spaceAttachmentId } from "./index.ts";

Deno.test("Attachment identity is unambiguous and rejects alternative record keys", () => {
  assertNotEquals(spaceAttachmentId("a:b", "c"), spaceAttachmentId("a", "b:c"));
  const record = {
    id: spaceAttachmentId("doc", "a"),
    collection: "doc",
    recordId: "a",
    spaceId: "one",
  };
  assertEquals(
    spaceAttachmentCollection.beforeCreate!(record, { namespace: "tenant" }),
    record,
  );
  assertThrows(() =>
    spaceAttachmentCollection.beforeUpdate!({ ...record, recordId: "b" }, {
      namespace: "tenant",
    })
  );
});
