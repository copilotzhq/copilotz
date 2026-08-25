import { assertEquals } from "@std/assert";
import { CHANNEL_INGRESS_ACTION_ID, channelIngressAction } from "./index.ts";

Deno.test("channel ingress action has the canonical ID", () => {
  assertEquals(channelIngressAction.id, CHANNEL_INGRESS_ACTION_ID);
});
