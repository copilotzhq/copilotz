import { assertEquals } from "@std/assert";
import { scheduledJobsTickInputProcessor } from "./index.ts";

Deno.test("tick input Processor retains its canonical id", () => {
  assertEquals(scheduledJobsTickInputProcessor.id, "schedules.tick-input");
});

Deno.test("tick input processor consumes resolved event data", async () => {
  let received: unknown;
  await scheduledJobsTickInputProcessor.handle(
    {
      durable: true,
      payload: { checkedAt: "2020-01-01T00:00:00.000Z", limit: 1 },
      data: { checkedAt: "2026-09-22T00:00:00.000Z", limit: 20 },
    } as never,
    {
      actions: {
        tickScheduledJobs: async (input: unknown) => {
          received = input;
          return {};
        },
      },
    } as never,
  );

  assertEquals(received, {
    checkedAt: "2026-09-22T00:00:00.000Z",
    limit: 20,
  });
});
