import { assertEquals } from "@std/assert";
import { personalMemoryContext } from "./index.ts";

Deno.test("personal context fails closed when a thread member cannot be resolved", async () => {
  let notesRead = false;
  const result = await personalMemoryContext.contribute({
    initiatorParticipantId: "human",
    thread: { id: "thread" },
    collections: {
      thread: {
        get: () => Promise.resolve({ participantIds: ["human", "hidden"] }),
      },
      participant: {
        list: () =>
          Promise.resolve([{ id: "human", participantType: "human" }]),
      },
      memoryNote: {
        list: () => {
          notesRead = true;
          return Promise.resolve([]);
        },
      },
    },
  } as never);
  assertEquals(result, null);
  assertEquals(notesRead, false);
});

Deno.test("personal context without a human initiator does not read memory", async () => {
  assertEquals(
    await personalMemoryContext.contribute(
      { collections: {}, thread: { id: "thread" } } as never,
    ),
    null,
  );
});
