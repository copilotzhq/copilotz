import { assert, assertEquals } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createEventStore,
  createSqlSession,
  provisionCopilotzSchema,
} from "../events/index.ts";

Deno.test("execution history keeps duplicate results singular while independent completions remain distinct", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "execution_history_characterization";
  const input = { task: "research", nested: { revision: 1 } };
  try {
    const session = createSqlSession(db);
    await provisionCopilotzSchema(session, schema);
    const store = createEventStore({ session, schema, random: () => 0 });
    const draft = {
      type: "task.result.completed",
      namespace: "tenant-a",
      threadId: "thread-a",
      payload: { taskInput: input, result: { status: "completed" } },
      deduplicationId: "task:plan-a:branch-0:result",
    } as const;

    const first = await store.append(draft, ["history.project"]);
    input.nested.revision = 2;
    const replay = await store.append({
      ...draft,
      payload: {
        taskInput: { task: "research", nested: { revision: 1 } },
        result: { status: "completed" },
      },
    }, ["history.project"]);
    const independent = await Promise.all([
      store.append({
        ...draft,
        deduplicationId: "task:plan-a:branch-1:result",
        payload: { taskInput: { branch: 1 }, result: { status: "completed" } },
      }, ["history.project"]),
      store.append({
        ...draft,
        deduplicationId: "task:plan-a:branch-2:result",
        payload: { taskInput: { branch: 2 }, result: { status: "completed" } },
      }, ["history.project"]),
    ]);

    assertEquals(replay.deduplicated, true);
    assertEquals(replay.event.id, first.event.id);
    assertEquals(
      first.deliveries.map((delivery) => delivery.id),
      replay.deliveries.map((delivery) => delivery.id),
    );
    assertEquals(first.event.payload, {
      taskInput: { task: "research", nested: { revision: 1 } },
      result: { status: "completed" },
    });

    assertEquals(independent.map((result) => result.deduplicated), [
      false,
      false,
    ]);
    assert(new Set(independent.map((result) => result.event.id)).size === 2);
  } finally {
    await db.close();
  }
});
