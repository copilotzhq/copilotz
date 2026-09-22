import { assertEquals } from "@std/assert";
import { scheduledJobRunNowInputProcessor } from "./index.ts";

Deno.test("run-now input Processor retains its canonical id", () => {
  assertEquals(scheduledJobRunNowInputProcessor.id, "schedules.run-now-input");
});

Deno.test("run-now input processor consumes resolved event data", async () => {
  let received: unknown;
  await scheduledJobRunNowInputProcessor.handle(
    {
      durable: true,
      payload: { id: "stale-job" },
      data: { id: "job-a", scheduledFor: "2026-09-22T00:00:00.000Z" },
    } as never,
    {
      actions: {
        runScheduledJobNow: async (input: unknown) => {
          received = input;
          return {};
        },
      },
    } as never,
  );

  assertEquals(received, {
    id: "job-a",
    scheduledFor: "2026-09-22T00:00:00.000Z",
  });
});
