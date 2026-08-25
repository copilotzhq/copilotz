import { assertEquals } from "@std/assert";
import { channelIngressProcessor } from "./index.ts";

Deno.test("channel ingress processor has its canonical ID", () => {
  assertEquals(channelIngressProcessor.id, "copilotz.channels.ingress-input");
});
