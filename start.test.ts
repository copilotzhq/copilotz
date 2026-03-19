import { createCopilotz } from "./index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ??
        `Assertion failed.\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("start() normalizes thread external IDs for initial message objects", async () => {
  const globalWithPrompt = globalThis as typeof globalThis & {
    prompt?: (message?: string) => string | null | undefined;
  };
  const originalPrompt = globalWithPrompt.prompt;
  globalWithPrompt.prompt = () => "quit";
  const copilotz = await createCopilotz({
    agents: [],
    dbConfig: { url: ":memory:" },
  });

  try {
    const firstController = copilotz.start({
      banner: null,
      content: "Hello",
      sender: { type: "user", name: "Tester" },
      thread: {
        participants: ["assistant"],
      },
    });

    await firstController.closed;

    const firstThreads = await copilotz.ops.crud.threads.find({});
    assertEquals(firstThreads.length, 1);
    assert(
      typeof firstThreads[0]?.externalId === "string" &&
        firstThreads[0].externalId.length > 0,
      "Expected start() to persist a generated thread external ID.",
    );

    const secondController = copilotz.start({
      banner: null,
      threadExternalId: "session-123",
      content: "Hello",
      sender: { type: "user", name: "Tester" },
      thread: {
        externalId: "payload-thread-id",
        participants: ["assistant"],
      },
    });

    await secondController.closed;

    const thread = await copilotz.ops.crud.threads.findOne({
      externalId: "session-123",
    });
    assert(
      thread,
      "Expected start() to persist the explicit threadExternalId.",
    );
    assertEquals(thread?.externalId, "session-123");
  } finally {
    globalWithPrompt.prompt = originalPrompt;
    await copilotz.shutdown();
  }
});
