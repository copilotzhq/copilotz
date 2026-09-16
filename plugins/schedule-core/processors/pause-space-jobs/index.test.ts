import { assertEquals } from "@std/assert";
import processor from "./index.ts";
import { CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE } from "../../shared/contracts.ts";

Deno.test("Space job pausing reaches later pages and leaves unrelated jobs active", async () => {
  const attachments = Array.from({ length: 201 }, (_, index) => ({
    id: `attachment-${index}`,
    recordId: `job-${index}`,
    spaceId: "space-a",
  }));
  const paused: string[] = [];
  const pages: (string | undefined)[] = [];
  await processor.handle(
    { durable: true, data: { record: { recordId: "thread-a" } } } as never,
    {
      now: () => new Date("2026-09-16T00:00:00Z"),
      collections: {
        thread: { get: () => Promise.resolve({ id: "thread-a" }) },
        spaceAttachment: {
          list: ({ after }: { after?: string }) => {
            pages.push(after);
            return Promise.resolve(
              after ? attachments.slice(200) : attachments.slice(0, 200),
            );
          },
          get: ({ id }: { id: string }) =>
            Promise.resolve(
              id.startsWith("attachment-")
                ? { spaceId: "space-a" }
                : { spaceId: "space-b" },
            ),
        },
        scheduledJob: {
          get: ({ id }: { id: string }) =>
            Promise.resolve({
              id,
              status: "active",
              payload: {
                type: CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE,
                thread: { id: id === "job-200" ? "thread-a" : "unrelated" },
              },
            }),
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
  assertEquals(pages, [undefined, "attachment-199"]);
  assertEquals(paused, ["job-200"]);
});
