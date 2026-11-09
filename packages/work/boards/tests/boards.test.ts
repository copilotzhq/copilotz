/**
 * Boards' Actions, as people use them: a board with the usual columns (or
 * its own), cards made, changed (null clears), moved within and across
 * columns (before or after a card, at the top or bottom, the column
 * numbered again when its gaps run out), columns added, renamed, reordered
 * and removed (only when empty, or with their cards moved), boards and
 * cards deleted. And the rules: someone outside the space neither reads nor
 * changes anything there; a viewer reads and can't write; from outside (the
 * REST API, a browser's socket), boards are read directly but changed only
 * through their Actions.
 */
import assert from "node:assert/strict";
import { test } from "copilotz/testing";
import type { Runtime } from "copilotz";
import type { Card, Column } from "../contract.ts";
import { byOrder } from "../shared/order.ts";
import { ana, bob, cy, failure, join, peekAs, start, stores } from "./start.ts";

/** A column's card titles, top to bottom. */
const titles = async (rt: Runtime, space: string, column: string) =>
  byOrder((await peekAs(rt, ana, space)).cards.filter((c) => c.column === column))
    .map((c) => c.title);

const add = async (
  rt: Runtime,
  board: string,
  title: string,
  extra: Record<string, unknown> = {},
) =>
  (await rt.call<{ card: string }>("card.create", { board, title, ...extra }, { actor: ana })).card;

const move = (rt: Runtime, card: string, to: Record<string, unknown>) =>
  rt.call<{ column: string; order: number }>("card.move", { card, ...to }, { actor: ana });

for (const [name, make] of Object.entries(stores)) {
  test(`${name}: a board starts with the usual columns, and its cards go where they're put`, async () => {
    const rt = await start(make);
    try {
      const { space } = await rt.call<{ space: string }>("space.create", { name: "Launch" }, {
        actor: ana,
      });
      const made = await rt.call<{ board: string; columns: Column[] }>("board.create", {
        in: space,
        name: "  Launch plan ",
        description: "Everything for the launch",
      }, { actor: ana });
      assert.deepEqual(made.columns.map((c) => c.name), [
        "Backlog",
        "To do",
        "Doing",
        "Blocked",
        "In review",
        "Done",
      ]);
      const { boards: [board] } = await peekAs(rt, ana, space);
      assert.equal(board.name, "Launch plan");
      assert.equal(board.by, "person:ana");
      // Its own columns, each with an id from its name.
      const own = await rt.call<{ columns: Column[] }>("board.create", {
        in: space,
        name: "Hiring",
        columns: ["Sourced", "Interview", "Offer"],
      }, { actor: ana });
      assert.deepEqual(own.columns, [
        { id: "sourced", name: "Sourced" },
        { id: "interview", name: "Interview" },
        { id: "offer", name: "Offer" },
      ]);

      // New cards go to the first column, at its bottom, unless told otherwise.
      const a = await add(rt, made.board, "Write the FAQ");
      const b = await add(rt, made.board, "Ship pricing page");
      const c = await add(rt, made.board, "Draft the announcement", { at: "top" });
      assert.deepEqual(await titles(rt, space, "backlog"), [
        "Draft the announcement",
        "Write the FAQ",
        "Ship pricing page",
      ]);
      const d = await add(rt, made.board, "Book the venue", { column: "todo" });
      assert.deepEqual(await titles(rt, space, "todo"), ["Book the venue"]);
      assert.equal(
        (await failure(add(rt, made.board, "Nowhere", { column: "later" }))).code,
        "invalid",
      );

      // Moves: before and after a card (joining its column), top and bottom, across columns.
      await move(rt, b, { before: c });
      assert.deepEqual(await titles(rt, space, "backlog"), [
        "Ship pricing page",
        "Draft the announcement",
        "Write the FAQ",
      ]);
      await move(rt, a, { after: d });
      assert.deepEqual(await titles(rt, space, "todo"), ["Book the venue", "Write the FAQ"]);
      await move(rt, c, { column: "todo", at: "top" });
      assert.deepEqual(await titles(rt, space, "todo"), [
        "Draft the announcement",
        "Book the venue",
        "Write the FAQ",
      ]);
      await move(rt, c, { at: "bottom" });
      assert.deepEqual(await titles(rt, space, "todo"), [
        "Book the venue",
        "Write the FAQ",
        "Draft the announcement",
      ]);
      const done = await move(rt, d, { column: "done" });
      assert.equal(done.column, "done");
      assert.deepEqual(await titles(rt, space, "backlog"), ["Ship pricing page"]);
      assert.equal((await failure(move(rt, a, { before: a }))).code, "invalid");
      assert.equal((await failure(move(rt, a, { at: "top", before: c }))).code, "invalid");
      assert.equal((await failure(move(rt, a, { column: "later" }))).code, "invalid");

      // Squeezed in after the same card again and again, until no midpoint fits: renumbered.
      const e = await add(rt, made.board, "Order the swag", { column: "todo" });
      assert.deepEqual(await titles(rt, space, "todo"), [
        "Write the FAQ",
        "Draft the announcement",
        "Order the swag",
      ]);
      for (let i = 0; i < 35; i++) {
        await move(rt, e, { after: a });
        await move(rt, c, { after: a });
      }
      assert.deepEqual(await titles(rt, space, "todo"), [
        "Write the FAQ",
        "Draft the announcement",
        "Order the swag",
      ]);
      const todo = (await peekAs(rt, ana, space)).cards.filter((x) => x.column === "todo");
      // Seventy halvings of a step leave no room in a double: only renumbering keeps them apart.
      const orders = todo.map((x) => x.order).sort((x, y) => x - y);
      assert.ok(orders[1] - orders[0] > 1e-7 && orders[2] - orders[1] > 1e-7, String(orders));
    } finally {
      await rt.close();
    }
  });

  test(`${name}: a card's fields change, and null clears them`, async () => {
    const rt = await start(make);
    try {
      const { space } = await rt.call<{ space: string }>("space.create", { name: "Launch" }, {
        actor: ana,
      });
      const { board } = await rt.call<{ board: string }>("board.create", {
        in: space,
        name: "Plan",
      }, { actor: ana });
      const card = await add(rt, board, "Ship pricing page", {
        description: "Live at /pricing.",
        assignee: "agent:north",
        labels: ["web", " launch ", "Web"],
        due: "2026-11-02",
      });
      const read = async () =>
        (await peekAs(rt, ana, space)).cards.find((c) => c._id === card) as Card;
      let now = await read();
      assert.deepEqual(now.labels, ["web", "launch"]);
      assert.equal(now.assignee, "agent:north");
      assert.equal(now.by, "person:ana");

      await rt.call("card.update", {
        card,
        title: "Ship the pricing page",
        assignee: "person:ana",
        due: null,
        labels: null,
        description: null,
      }, { actor: ana });
      now = await read();
      assert.equal(now.title, "Ship the pricing page");
      assert.equal(now.assignee, "person:ana");
      assert.equal(now.due, undefined);
      assert.equal(now.labels, undefined);
      assert.equal(now.description, undefined);
      assert.equal(now.updatedBy, "person:ana");
      assert.ok(now.updated);

      // Only someone in the space takes a card; only real days are due dates.
      const outsider = await failure(
        rt.call("card.update", { card, assignee: "agent:west" }, { actor: ana }),
      );
      assert.equal(outsider.code, "invalid");
      assert.match(outsider.message, /west isn't in this space/);
      assert.equal(
        (await failure(rt.call("card.update", { card, assignee: "person:bob" }, { actor: ana })))
          .code,
        "invalid",
      );
      assert.equal(
        (await failure(rt.call("card.update", { card, due: "2026-02-30" }, { actor: ana }))).code,
        "invalid",
      );
      assert.equal(
        (await failure(rt.call("card.update", { card, title: "   " }, { actor: ana }))).code,
        "invalid",
      );
      await rt.call("card.update", { card, assignee: null }, { actor: ana });
      assert.equal((await read()).assignee, undefined);

      const gone = await rt.call<{ deleted: string }>("card.delete", { card }, { actor: ana });
      assert.equal(gone.deleted, card);
      assert.equal((await peekAs(rt, ana, space)).cards.length, 0);
      assert.equal(
        (await failure(rt.call("card.update", { card, title: "Back" }, { actor: ana }))).code,
        "not_found",
      );
    } finally {
      await rt.close();
    }
  });

  test(`${name}: columns are added, renamed, reordered, and removed when empty or emptied`, async () => {
    const rt = await start(make);
    try {
      const { space } = await rt.call<{ space: string }>("space.create", { name: "Launch" }, {
        actor: ana,
      });
      const { board, columns } = await rt.call<{ board: string; columns: Column[] }>(
        "board.create",
        { in: space, name: "Plan", columns: ["To do", "Doing", "Done"] },
        { actor: ana },
      );
      const [todo, doing, done] = columns;
      const first = await add(rt, board, "First", { column: doing.id });
      const second = await add(rt, board, "Second", { column: doing.id });
      await add(rt, board, "Shipped", { column: done.id });

      // Renamed, reordered, one added; the description cleared.
      await rt.call("board.update", {
        board,
        name: "Launch plan",
        description: "For the launch",
      }, { actor: ana });
      const updated = await rt.call<{ columns: Column[] }>("board.update", {
        board,
        description: null,
        columns: [
          { id: doing.id, name: "In progress" },
          { id: todo.id, name: "To do" },
          { name: "QA" },
          { id: done.id, name: "Done" },
        ],
      }, { actor: ana });
      assert.deepEqual(updated.columns.map((c) => c.name), ["In progress", "To do", "QA", "Done"]);
      assert.equal(updated.columns[2].id, "qa");
      let seen = (await peekAs(rt, ana, space)).boards[0];
      assert.equal(seen.name, "Launch plan");
      assert.equal(seen.description, undefined);
      assert.equal(seen.columns[0].id, doing.id);

      // An empty column goes; one with cards stays, unless its cards go elsewhere.
      await rt.call("board.update", {
        board,
        columns: seen.columns.filter((c) => c.id !== "qa"),
      }, { actor: ana });
      const kept = await failure(rt.call("board.update", {
        board,
        columns: [{ id: todo.id, name: "To do" }, { id: done.id, name: "Done" }],
      }, { actor: ana }));
      assert.equal(kept.code, "not_empty");
      assert.match(kept.message, /“In progress” still has cards/);
      assert.equal((await peekAs(rt, ana, space)).boards[0].columns.length, 3);
      const emptied = await rt.call<{ moved: number }>("board.update", {
        board,
        columns: [{ id: todo.id, name: "To do" }, { id: done.id, name: "Done" }],
        into: done.id,
      }, { actor: ana });
      assert.equal(emptied.moved, 2);
      assert.deepEqual(await titles(rt, space, done.id), ["Shipped", "First", "Second"]);
      seen = (await peekAs(rt, ana, space)).boards[0];
      assert.deepEqual(seen.columns.map((c) => c.name), ["To do", "Done"]);
      assert.equal(
        (await failure(rt.call("board.update", {
          board,
          columns: [{ name: "Done" }, { name: "done" }],
        }, { actor: ana }))).code,
        "invalid",
      );
      assert.equal(
        (await failure(rt.call("board.update", {
          board,
          columns: [{ id: todo.id, name: "To do" }],
          into: done.id,
        }, { actor: ana }))).code,
        "invalid",
      );
      void first;
      void second;

      // Archived, brought back; then deleted with its cards.
      await rt.call("board.update", { board, archived: true }, { actor: ana });
      assert.ok((await peekAs(rt, ana, space)).boards[0].archived);
      await rt.call("board.update", { board, archived: false }, { actor: ana });
      assert.equal((await peekAs(rt, ana, space)).boards[0].archived, undefined);
      await rt.call("board.delete", { board }, { actor: ana });
      const after = await peekAs(rt, ana, space);
      assert.equal(after.boards.length, 0);
      assert.equal(after.cards.length, 0);
    } finally {
      await rt.close();
    }
  });

  test(`${name}: outside the space nothing is seen or changed; a viewer reads and can't write`, async () => {
    const rt = await start(make);
    try {
      const { space } = await rt.call<{ space: string }>("space.create", { name: "Launch" }, {
        actor: ana,
      });
      const { board } = await rt.call<{ board: string }>("board.create", {
        in: space,
        name: "Plan",
      }, { actor: ana });
      const card = await add(rt, board, "Ship pricing page");

      // Bob isn't in Launch: he sees nothing, and every change reads as nothing there.
      assert.deepEqual(await peekAs(rt, bob), { boards: [], cards: [] });
      assert.deepEqual(await peekAs(rt, bob, space), { boards: [], cards: [] });
      const outside = [
        rt.call("board.create", { in: space, name: "Mine" }, { actor: bob }),
        rt.call("board.update", { board, name: "Mine" }, { actor: bob }),
        rt.call("board.delete", { board }, { actor: bob }),
        rt.call("card.create", { board, title: "Mine" }, { actor: bob }),
        rt.call("card.update", { card, title: "Mine" }, { actor: bob }),
        rt.call("card.move", { card, column: "done" }, { actor: bob }),
        rt.call("card.delete", { card }, { actor: bob }),
      ];
      const codes = await Promise.all(outside.map(async (p) => (await failure(p)).code));
      assert.deepEqual(codes, [
        "forbidden",
        "not_found",
        "not_found",
        "not_found",
        "not_found",
        "not_found",
        "not_found",
      ]);
      // Nor can he put a board of his own on Launch's, or move his card there.
      const { space: his } = await rt.call<{ space: string }>("space.personal", {}, { actor: bob });
      const { board: mine } = await rt.call<{ board: string }>("board.create", {
        in: his,
        name: "Mine",
      }, { actor: bob });
      const theirs = await rt.call<{ card: string }>(
        "card.create",
        { board: mine, title: "Mine" },
        {
          actor: bob,
        },
      );
      assert.equal(
        (await failure(rt.call("card.move", { card: theirs.card, before: card }, { actor: bob })))
          .code,
        "invalid",
      );

      // A viewer reads all of it, and changes none of it.
      await join(rt, space, cy, "viewer", ana);
      const seen = await peekAs(rt, cy, space);
      assert.equal(seen.boards.length, 1);
      assert.equal(seen.cards.length, 1);
      const viewing = [
        rt.call("board.create", { in: space, name: "Mine" }, { actor: cy }),
        rt.call("board.update", { board, name: "Mine" }, { actor: cy }),
        rt.call("board.update", { board, columns: [{ name: "One" }] }, { actor: cy }),
        rt.call("board.delete", { board }, { actor: cy }),
        rt.call("card.create", { board, title: "Mine" }, { actor: cy }),
        rt.call("card.update", { card, title: "Mine" }, { actor: cy }),
        rt.call("card.move", { card, column: "done" }, { actor: cy }),
        rt.call("card.delete", { card }, { actor: cy }),
      ];
      for (const refused of await Promise.all(viewing.map(failure))) {
        assert.equal(refused.code, "forbidden", refused.message);
      }
      const still = await peekAs(rt, ana, space);
      assert.equal(still.boards[0].name, "Plan");
      assert.equal(still.boards[0].columns.length, 6);
      assert.equal(still.cards[0].title, "Ship pricing page");
      assert.equal(still.cards[0].column, "backlog");

      // Made an editor, they change it.
      await rt.call("member.set", { space, member: cy, role: "editor" }, { actor: ana });
      await rt.call("card.move", { card, column: "doing" }, { actor: cy });
      assert.equal((await peekAs(rt, ana, space)).cards[0].updatedBy, "person:cy");
    } finally {
      await rt.close();
    }
  });

  test(`${name}: from outside, boards and cards are read directly, and changed only by their Actions`, async () => {
    const rt = await start(make);
    try {
      const { space } = await rt.call<{ space: string }>("space.create", { name: "Launch" }, {
        actor: ana,
      });
      const { board } = await rt.call<{ board: string }>("board.create", {
        in: space,
        name: "Plan",
      }, { actor: ana });
      const card = await add(rt, board, "Ship pricing page");
      // Ana's browser (her session's cookie), at the app's REST API.
      const { session } = await rt.call<{ session: string }>("session.start", { person: "ana" });
      const rest = (method: string, path: string, body?: unknown) =>
        rt.fetch(
          new Request(`http://127.0.0.1/api/collections/${path}`, {
            method,
            headers: { cookie: `session=${session}`, "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      const read = await rest("GET", `card/${card}`);
      assert.equal(read.status, 200);
      assert.equal((await read.json()).title, "Ship pricing page");
      const writes = [
        await rest("PATCH", `card/${card}`, { title: "Mine", column: "nowhere" }),
        await rest("PATCH", `board/${board}`, { columns: [] }),
        await rest("POST", "card", {
          board,
          in: space,
          title: "Sneaked",
          column: "todo",
          order: 1,
        }),
        await rest("DELETE", `board/${board}`),
      ];
      for (const answer of writes) {
        assert.equal(answer.status, 403, await answer.text());
      }
      const { boards: [kept], cards } = await peekAs(rt, ana, space);
      assert.equal(kept.columns.length, 6);
      assert.deepEqual(cards.map((c) => c.title), ["Ship pricing page"]);
    } finally {
      await rt.close();
    }
  });
}
