import { assertEquals } from "@std/assert";
import { channelIngress } from "./index.ts";

Deno.test("channel ingress creates the ingress event", () => {
  assertEquals(
    channelIngress("web", { id: "one", input: {} }).type,
    "copilotz.channels.ingress.input",
  );
});
