import { assertEquals } from "@std/assert";
import {
  CHANNEL_BINDING_COLLECTION,
  channelBindingCollection,
} from "./index.ts";

Deno.test("channel binding collection keeps its canonical name", () => {
  assertEquals(channelBindingCollection.name, CHANNEL_BINDING_COLLECTION);
});
