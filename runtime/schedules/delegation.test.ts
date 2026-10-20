import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { defineCollection } from "../collections/definition.ts";
import { scheduledJobDelegationDigest } from "./delegation.ts";
const input = () => ({
  databaseSchema: "fixture",
  namespace: "space",
  record: {
    id: "job",
    status: "active",
    schedule: { type: "cron", expression: "* * * * *" },
    payload: { threadId: "thread" },
    content: [],
    metadata: { creator: "member" },
    spaceId: "space-a",
  },
});
Deno.test("scheduled delegation digest binds authority fields and ignores only evolving non-authority fields", async () => {
  const original = input();
  const digest = await scheduledJobDelegationDigest(original);
  assertEquals(
    await scheduledJobDelegationDigest({
      ...original,
      record: {
        ...original.record,
        name: "Renamed",
        nextRunAt: "later",
        nextRunAtMs: 4,
        lastOccurrence: { id: "new" },
        updatedAt: "later",
        createdAt: "old",
      },
    }),
    digest,
  );
  assertEquals(
    await scheduledJobDelegationDigest({
      ...original,
      record: {
        metadata: { creator: "member" },
        content: [],
        payload: { threadId: "thread" },
        schedule: { expression: "* * * * *", type: "cron" },
        spaceId: "space-a",
        status: "active",
        id: "job",
      },
    }),
    digest,
  );
  for (
    const patch of [
      { id: "other" },
      { spaceId: "other" },
      { status: "paused" },
      { schedule: { type: "cron", expression: "0 * * * *" } },
      { payload: { threadId: "other" } },
      { content: [{ text: "other" }] },
      { metadata: { creator: "other" } },
    ]
  ) {
    assertNotEquals(
      await scheduledJobDelegationDigest({
        ...original,
        record: { ...original.record, ...patch },
      }),
      digest,
    );
  }
  assertNotEquals(
    await scheduledJobDelegationDigest({ ...original, namespace: "other" }),
    digest,
  );
  assertNotEquals(
    await scheduledJobDelegationDigest({
      ...original,
      databaseSchema: "other",
    }),
    digest,
  );
});
Deno.test("scheduled delegation digest rejects noncanonical values without running accessors", async () => {
  let calls = 0;
  for (
    const value of [
      NaN,
      Infinity,
      undefined,
      () => 0,
      new Date(),
      {
        get secret() {
          calls++;
          return "private";
        },
      },
      new Map(),
      [, ,],
    ]
  ) {
    await assertRejects(() =>
      scheduledJobDelegationDigest({
        ...input(),
        record: { ...input().record, metadata: { value } },
      })
    );
  }
  assertEquals(calls, 0);
});

Deno.test("occurrence classification is restricted to the registered scheduled-job due alarm", () => {
  const alarm = {
    ingress: "scheduled-occurrence" as const,
    deadline: () => null,
    command: () => ({ name: "due", key: "due", input: {} }),
  };
  for (
    const [name, event] of [["other", "scheduled_job.due"], [
      "scheduled_job",
      "other.due",
    ]]
  ) {
    assertThrows(
      () =>
        defineCollection({
          name,
          schema: { type: "object" },
          alarm,
          commands: { due: { event, mutate() {} } },
        }),
      TypeError,
    );
  }
});
