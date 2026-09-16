import { assertRejects } from "@std/assert";
import { discordChannelAdapter } from "./index.ts";
Deno.test("Provider requires configuration at invocation", async () => {
  await assertRejects(
    async () =>
      await discordChannelAdapter.accept({
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
