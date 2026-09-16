import { assertRejects } from "@std/assert";
import { whatsappChannelAdapter } from "./index.ts";
Deno.test("Provider requires configuration at invocation", async () => {
  await assertRejects(
    async () =>
      await whatsappChannelAdapter.accept({
        method: "POST",
        headers: {},
        body: {},
      }, {
        namespace: "test",
        channelId: "missing",
        channel: { egress: "external" },
        signal: new AbortController().signal,
        now: () => new Date(),
      }),
    TypeError,
    "requires config",
  );
});
