import { assertEquals } from "@std/assert";
import { channelEgressProcessor } from "./index.ts";

Deno.test("channel egress processor has its canonical ID", () => {
  assertEquals(channelEgressProcessor.id, "copilotz.channels.external-egress");
});
