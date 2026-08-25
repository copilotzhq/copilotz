import { assertEquals } from "@std/assert";
import { CHANNEL_EGRESS_ACTION_ID, channelEgressAction } from "./index.ts";

Deno.test("channel egress action has the canonical ID", () => {
  assertEquals(channelEgressAction.id, CHANNEL_EGRESS_ACTION_ID);
});
