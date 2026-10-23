import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserRuntime } from "@copilotz/copilotz/web";
import {
  MemorySubscriptions,
  record,
  tick,
} from "../../../client/testing/live-transport.test.ts";
import { coreWebPlugin } from "../web.ts";
import { messageReadSelection, readThreadMessages } from "./reads.ts";

const newestFirst = {
  where: { threadId: "t" },
  order: { field: "createdAt", direction: "desc" },
  limit: 100,
} as const;

// Human ids are time-ordered; agent replies use derived ids that sort after
// them, so id order would list every human message before any agent reply.
const message = (id: string, minute: number) =>
  record({ id, threadId: "t", createdAt: `2026-10-20T10:0${minute}:00.000Z` });

test("the feed reads the newest messages and shows them oldest first", async () => {
  const live = new MemorySubscriptions();
  const observed: unknown[] = [];
  const observe = live.observe.bind(live);
  live.observe = (collection, query, options) => {
    if (collection === "message") observed.push(query);
    return observe(collection, query, options);
  };
  await live.publish({
    collection: "message",
    query: newestFirst,
    ...messageReadSelection,
  }, {
    t: "snapshot",
    complete: true,
    // The owner answers the newest window, newest first.
    rows: [
      message("message:run-b:output", 4),
      message("01K8B", 3),
      message("message:run-a:output", 2),
      message("01K8A", 1),
    ],
    sequence: "1",
    checkpoint: "1",
  });
  const runtime = await createBrowserRuntime({
    plugins: [coreWebPlugin],
    live,
  });
  const feed = runtime.observe((ctx) => readThreadMessages(ctx, "t"));
  try {
    await tick();
    assert.deepEqual(observed, [newestFirst]);
    assert.equal(feed.getSnapshot().status, "ready");
    assert.deepEqual(feed.getSnapshot().value.map((row) => row.id), [
      "01K8A",
      "message:run-a:output",
      "01K8B",
      "message:run-b:output",
    ]);

    // A new reply enters the window and the oldest message leaves it.
    await live.publish({
      collection: "message",
      query: newestFirst,
      ...messageReadSelection,
    }, {
      t: "batch",
      checkpoint: "2",
      from: "1",
      to: "2",
      // Field-ordered windows carry the owner's selected order.
      order: [
        "message:run-c:output",
        "message:run-b:output",
        "01K8B",
        "message:run-a:output",
      ],
      changes: [
        { seq: "2", id: "01K8A", record: null },
        {
          seq: "2",
          id: "message:run-c:output",
          record: message("message:run-c:output", 5),
        },
      ],
    });
    await tick();
    assert.deepEqual(feed.getSnapshot().value.map((row) => row.id), [
      "message:run-a:output",
      "01K8B",
      "message:run-b:output",
      "message:run-c:output",
    ]);
  } finally {
    feed.dispose();
    runtime.dispose();
  }
});

test("the chat window's content selection is valid input to the visibility projection's history read", async () => {
  // Live message windows project each row through Core `history` with the
  // window's own content selection; a narrower schema refused every window.
  const { messageCollection } = await import(
    "../collections/message/index.ts"
  );
  const { validateAgainstJsonSchema } = await import(
    "../../../runtime/collections/validate.ts"
  );
  const history = messageCollection.queries?.history;
  assert.ok(history?.inputSchema);
  validateAgainstJsonSchema(history.inputSchema, {
    threadId: "t",
    messageId: "m",
    view: "all",
    viewerParticipantIds: ["human"],
    content: messageReadSelection.content,
  }, "history input");
});
