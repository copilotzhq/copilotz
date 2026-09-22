import { assertEquals } from "@std/assert";
import { channelIngressProcessor } from "./index.ts";

Deno.test("channel ingress processor has its canonical ID", () => {
  assertEquals(channelIngressProcessor.id, "copilotz.channels.ingress-input");
});

Deno.test("channel ingress processor consumes resolved event data", async () => {
  let received: unknown;
  await channelIngressProcessor.handle(
    {
      durable: true,
      id: "event-a",
      correlationId: "correlation-a",
      payload: { dataRef: { eventBodyId: "body-a" } },
      data: {
        channelId: "support",
        id: "occurrence-a",
        input: { message: "hello" },
      },
    } as never,
    {
      actions: {
        channelIngress: async (input: unknown) => {
          received = input;
        },
      },
      identity: { settlementScopeId: "scope-a" },
      signal: new AbortController().signal,
    } as never,
  );

  assertEquals(received, {
    channelId: "support",
    id: "occurrence-a",
    input: { message: "hello" },
  });
});
