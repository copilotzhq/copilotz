import { assertEquals } from "@std/assert";
import { channelDeliverAction } from "./index.ts";
import type { ChannelActionContext } from "../ingress/index.ts";
import { testEffect } from "../../../../runtime/testing/effects.ts";

Deno.test("confirmed channel delivery replays without provider config or collected content", async () => {
  const receipt = {
    deliveryKey: "delivery",
    delivered: 1,
    providerIds: ["safe-reference"],
  };
  const context = {
    signal: new AbortController().signal,
    effect: {
      ...testEffect,
      begin: () =>
        Promise.resolve({ status: "replay", outcome: receipt } as const),
    },
  } as unknown as ChannelActionContext;
  assertEquals(
    await channelDeliverAction.execute(
      { deliveryKey: "delivery" } as never,
      context,
    ),
    receipt,
  );
});
