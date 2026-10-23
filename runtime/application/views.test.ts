import { rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { createCopilotz } from "../../create-copilotz.ts";
import { definePlugin } from "../plugins/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { defineView } from "../views/index.ts";
import { createCopilotzApplication } from "./application.ts";

const board = defineView({
  id: "application.board",
  shows: "board",
  renderer: "text",
  modes: ["context"],
  render: (item: { title: string }) => item.title,
});

test("application initialization preserves direct Views through ingress composition", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  try {
    const application = await createCopilotzApplication({
      database,
      namespace: "view-test",
      views: { board },
    });
    try {
      strictEqual(application.plugins.views.board, board);
      strictEqual(
        application.plugins.resolveView("board", "context", "text"),
        board,
      );
    } finally {
      await application.shutdown();
    }
  } finally {
    await database.close();
  }
});

test("public embedded, Gateway, and Worker factories forward Views for collision validation", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  const plugin = definePlugin({ id: "views", version: "1", views: { board } });
  const options = { database, plugins: [plugin], views: { board } };
  // Each factory must settle promptly: a refused composition opens nothing.
  const bounded = async <T>(label: string, run: () => Promise<T>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} did not settle`)),
            10_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await bounded(
      "embedded",
      () => rejects(() => createCopilotz(options), /View alias 'board'/),
    );
    await bounded("gateway", () =>
      rejects(
        () => createCopilotz({ ...options, role: "gateway" }),
        /View alias 'board'/,
      ));
    await bounded("worker", () =>
      rejects(() =>
        createCopilotz({
          plugins: options.plugins,
          views: options.views,
          role: "worker",
          id: "view-test-worker",
          transport: { type: "in-process", config: { topic: "views-test" } },
        }), /View alias 'board'/));
    // Nothing leaked: the same database starts a valid application promptly.
    const app = await bounded(
      "valid embedded start",
      () => createCopilotz({ database, plugins: [plugin] }),
    );
    await app.close();
  } finally {
    await database.close();
  }
});
