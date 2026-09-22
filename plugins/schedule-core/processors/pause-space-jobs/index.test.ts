import { assertEquals } from "@std/assert";
import processor from "./index.ts";
import { CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE } from "../../shared/contracts.ts";

Deno.test("Space job pausing reaches later pages and leaves unrelated jobs active", async () => {
  const jobs = Array.from({ length: 201 }, (_, index) => ({
    id: `job-${index}`,
    status: "active",
    spaceId: "space-a",
    payload: {
      type: CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE,
      thread: { id: index === 200 ? "thread-a" : "unrelated" },
    },
  }));
  const paused: string[] = [];
  const pages: (string | undefined)[] = [];
  await processor.handle(
    {
      durable: true,
      type: "thread.updated",
      data: {
        set: { spaceId: "space-b" },
        record: { id: "thread-a" },
      },
    } as never,
    {
      now: () => new Date("2026-09-16T00:00:00Z"),
      collections: {
        thread: {
          get: () => Promise.resolve({ id: "thread-a", spaceId: "space-b" }),
        },
        scheduledJob: {
          list: ({ after }: { after?: string }) => {
            pages.push(after);
            return Promise.resolve(
              after ? jobs.slice(200) : jobs.slice(0, 200),
            );
          },
          get: ({ id }: { id: string }) =>
            Promise.resolve(
              jobs.find((job) => job.id === id),
            ),
        },
      },
      transaction: (execute: (tx: unknown) => Promise<void>) =>
        execute({
          collections: {
            space: { commands: { touch: () => Promise.resolve() } },
            scheduledJob: {
              update: (
                { id, set }: { id: string; set: { status: string } },
              ) => {
                assertEquals(set.status, "paused");
                paused.push(id);
                return Promise.resolve();
              },
            },
          },
        }),
    } as never,
  );
  assertEquals(pages, [undefined, "job-199"]);
  assertEquals(paused, ["job-200"]);
});
