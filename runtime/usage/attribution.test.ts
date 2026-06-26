import { assertEquals } from "@std/assert";
import {
  pickRunSenderFromMetadata,
  resolveInitiatedById,
  runSenderExternalId,
  withRunSenderMetadata,
} from "./attribution.ts";

Deno.test("runSenderExternalId prefers externalId then id", () => {
  assertEquals(
    runSenderExternalId({ externalId: "ext-1", id: "id-1" }),
    "ext-1",
  );
  assertEquals(runSenderExternalId({ id: "id-1", name: "Name" }), "id-1");
  assertEquals(runSenderExternalId({ name: "Alice" }), "Alice");
  assertEquals(runSenderExternalId(null), null);
});

Deno.test("pickRunSenderFromMetadata extracts runSender object", () => {
  const sender = { type: "user", externalId: "user-1" };
  assertEquals(
    pickRunSenderFromMetadata({ runSender: sender }),
    sender,
  );
  assertEquals(pickRunSenderFromMetadata({}), undefined);
  assertEquals(pickRunSenderFromMetadata(null), undefined);
});

Deno.test("withRunSenderMetadata preserves and injects runSender", () => {
  const sender = { type: "user", externalId: "user-1" };
  assertEquals(
    withRunSenderMetadata({ batchId: "b1" }, sender),
    { batchId: "b1", runSender: sender },
  );
  assertEquals(withRunSenderMetadata(undefined, undefined), undefined);
});

Deno.test("resolveInitiatedById falls back to thread user identity", () => {
  assertEquals(
    resolveInitiatedById({
      runSender: null,
      threadMetadata: {
        system: {
          memory: {
            identity: { userExternalId: "usr_alice" },
          },
        },
      },
    }),
    "usr_alice",
  );
  assertEquals(
    resolveInitiatedById({
      initiatedById: "explicit",
      runSender: { externalId: "sender" },
      threadMetadata: {
        system: { memory: { identity: { userExternalId: "thread-user" } } },
      },
    }),
    "explicit",
  );
  assertEquals(
    resolveInitiatedById({
      runSender: { externalId: "sender" },
      threadMetadata: {
        system: { memory: { identity: { userExternalId: "thread-user" } } },
      },
    }),
    "sender",
  );
});
