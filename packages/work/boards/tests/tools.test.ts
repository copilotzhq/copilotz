/**
 * Boards' tools, end to end: an agent in a space's conversation lists the
 * boards there, makes one, adds cards (in a column named loosely, owned by
 * itself, another agent or a person named by email), moves them (by id or
 * title, top or bottom), changes them (empty clears), and reads the board
 * back; names that match nobody, columns that don't exist, and other
 * spaces' boards and cards are said plainly. Each answer reads back as its
 * View in the conversation shows it (`heard`).
 */
import assert from "node:assert/strict";
import { test } from "copilotz/testing";
import type { Actor, Runtime } from "copilotz";
import { heard } from "../shared/said.ts";
import { ana, bob, failure, join, outputs, peekAs, start, stores } from "./start.ts";

/** Has the conversation's agent call `name` with `input`; what it answered. */
async function ask(rt: Runtime, at: { in?: string; thread?: string }, name: string, input = {}) {
  const sent = await rt.call<{ thread: string }>(
    "chat.send",
    { ...at, text: `tool ${name} ${JSON.stringify(input)}` },
    { actor: ana },
  );
  await rt.idle();
  at.thread = sent.thread;
  delete at.in;
  const said = outputs.splice(0);
  assert.equal(said.length, 1, `one answer from ${name}`);
  return said[0];
}

for (const [name, make] of Object.entries(stores)) {
  test(`${name}: an agent keeps its space's board: lists, makes, adds, moves, changes, reads`, async () => {
    const rt = await start(make);
    try {
      const { space } = await rt.call<{ space: string }>("space.create", { name: "Launch" }, {
        actor: ana,
      });
      await join(rt, space, bob, "editor", ana);
      const chat = { in: space } as { in?: string; thread?: string };

      assert.match(await ask(rt, chat, "list_boards"), /No boards in this space yet/);
      assert.match(await ask(rt, chat, "read_board"), /no board in this space yet/);

      const made = await ask(rt, chat, "create_board", {
        name: "Launch plan",
        description: "Everything for the launch",
      });
      const board = heard(made).boards[0];
      assert.equal(board.name, "Launch plan");
      assert.match(
        made,
        /^Made the board “Launch plan” \(\/board\/\w+\), with columns Backlog, To do/,
      );
      assert.equal((await peekAs(rt, ana, space)).boards[0].by, "agent:north");

      // Cards: a column named loosely; owned by the agent itself, another agent, a person.
      const pricing = await ask(rt, chat, "create_card", {
        title: "Ship pricing page",
        column: "to-do",
        assignee: "me",
        labels: ["web"],
        due: "2026-11-02",
      });
      assert.match(
        pricing,
        /^Created “Ship pricing page” \[\w+\] in To do, for North — on “Launch plan” \(\/board\/\w+\)\.$/,
      );
      const pricingId = heard(pricing).card!;
      assert.deepEqual(heard(pricing), {
        ok: true,
        head: "Created “Ship pricing page” in To do, for North",
        boards: [board],
        card: pricingId,
      });
      const faq = await ask(rt, chat, "create_card", {
        title: "Write the FAQ",
        assignee: "bob@example.com",
      });
      assert.match(faq, /in Backlog, for Bob \(bob@example\.com\)/);
      assert.match(
        await ask(rt, chat, "create_card", { title: "Test the checkout", assignee: "South" }),
        /for South/,
      );
      assert.match(
        await ask(rt, chat, "create_card", { title: "Hire", assignee: "bob" }),
        /for Bob/,
      );
      const nobody = await ask(rt, chat, "create_card", { title: "Legal", assignee: "West" });
      assert.match(nobody, /^Nobody called “West” is in this space\. Here: .*Bob.*North.*South/);
      assert.equal(heard(nobody).ok, false);
      assert.match(
        await ask(rt, chat, "create_card", { title: "Legal", column: "Later" }),
        /has no column “Later”\. Its columns: Backlog, To do, Doing, Blocked, In review, Done/,
      );

      // Moves: by id, by title, to the top.
      assert.match(
        await ask(rt, chat, "move_card", { card: pricingId, column: "Doing" }),
        /^Moved “Ship pricing page” \[\w+\] from To do to Doing — on “Launch plan”/,
      );
      const top = await ask(rt, chat, "move_card", {
        card: "write the faq",
        column: "doing",
        at: "top",
      });
      assert.match(top, /from Backlog to Doing \(at the top\)/);
      assert.equal(heard(top).head, "Moved “Write the FAQ” from Backlog to Doing (at the top)");
      assert.match(
        await ask(rt, chat, "move_card", { card: "Nothing like it", column: "Done" }),
        /^No card “Nothing like it” here/,
      );

      // Changes: empty clears; what changed is said.
      const updated = await ask(rt, chat, "update_card", {
        card: pricingId,
        assignee: "",
        due: null,
        labels: ["web", "launch"],
        description: "Done when /pricing is live with the three plans.",
      });
      assert.match(
        updated,
        /^Updated “Ship pricing page” \[\w+\]: description written, unassigned, labels web, launch, due date cleared — on/,
      );
      const card = (await peekAs(rt, ana, space)).cards.find((c) => c._id === pricingId)!;
      assert.equal(card.assignee, undefined);
      assert.equal(card.due, undefined);
      assert.deepEqual(card.labels, ["web", "launch"]);
      assert.equal(card.updatedBy, "agent:north");

      const read = await ask(rt, chat, "read_board", { board: "launch plan" });
      assert.match(read, /^Board “Launch plan” \(\/board\/\w+\): 6 columns, 4 cards\./);
      assert.match(read, /About: Everything for the launch/);
      assert.match(
        read,
        /## Doing \(2\)\n- \[\w+\] Write the FAQ · Bob \(bob@example\.com\)\n- \[\w+\] Ship pricing page · unassigned · labels: web, launch\n {2}Done when \/pricing is live/,
      );
      assert.match(read, /## Blocked \(0\)\n\(empty\)/);
      const listed = await ask(rt, chat, "list_boards");
      assert.match(
        listed,
        /1 board in this space:\n- “Launch plan” \(\/board\/\w+\): 4 cards \(Backlog 2, Doing 2\)/,
      );

      // Another space's board and cards are nowhere to be found from here.
      const { space: personal } = await rt.call<{ space: string }>("space.personal", {}, {
        actor: ana,
      });
      const { board: privateBoard } = await rt.call<{ board: string }>("board.create", {
        in: personal,
        name: "Private",
      }, { actor: ana });
      const { card: secret } = await rt.call<{ card: string }>("card.create", {
        board: privateBoard,
        title: "Weekend plans",
      }, { actor: ana });
      assert.match(
        await ask(rt, chat, "read_board", { board: "Private" }),
        /^No board “Private” in this space\. Its boards: “Launch plan”/,
      );
      assert.match(
        await ask(rt, chat, "move_card", { card: secret, column: "Done" }),
        /^No card/,
      );
      assert.match(
        await ask(rt, chat, "update_card", { card: "Weekend plans", title: "Mine now" }),
        /^No card/,
      );
      const untouched = (await peekAs(rt, ana, personal)).cards[0];
      assert.equal(untouched.title, "Weekend plans");
      assert.equal(untouched.column, "backlog");
    } finally {
      await rt.close();
    }
  });

  test(`${name}: people show by their names, never the ids they signed in with`, async () => {
    const rt = await start(make);
    try {
      const { space } = await rt.call<{ space: string }>("space.create", { name: "Launch" }, {
        actor: ana,
      });
      // Someone signed in with Google: their id says nothing, their name does.
      const dee: Actor = { kind: "person", id: "google:1139" };
      await rt.call("person.set", { person: dee.id, email: "dee@example.com", name: "Dee Ray" });
      const { invitation } = await rt.call<{ invitation: string }>("invitation.send", {
        space,
        email: "dee@example.com",
        role: "editor",
      }, { actor: ana });
      await rt.call("invitation.accept", { invitation }, { actor: dee });
      await rt.idle();
      const chat = { in: space } as { in?: string; thread?: string };
      await ask(rt, chat, "create_board", { name: "Launch plan" });
      assert.match(
        await ask(rt, chat, "create_card", { title: "Write the FAQ", assignee: "Dee" }),
        /for Dee Ray \(dee@example\.com\)/,
      );
      const read = await ask(rt, chat, "read_board");
      assert.match(read, /Write the FAQ · Dee Ray \(dee@example\.com\)/);
      assert.doesNotMatch(read, /google:1139/);

      // Gone from the space, their cards still say who they were.
      await rt.call("member.remove", { space, member: dee }, { actor: ana });
      const after = await ask(rt, chat, "read_board");
      assert.match(after, /Write the FAQ · Dee Ray\n/);
      assert.doesNotMatch(after, /google:1139/);
      assert.match(
        await ask(rt, chat, "create_card", { title: "Hire", assignee: "Dee" }),
        /^Nobody called “Dee” is in this space/,
      );
      const refused = await failure(
        rt.call("card.create", {
          board: (await peekAs(rt, ana, space)).boards[0]._id,
          title: "Hire",
          assignee: `person:${dee.id}`,
        }, { actor: ana }),
      );
      assert.equal(refused.message, "Dee Ray isn't in this space.");
    } finally {
      await rt.close();
    }
  });
}

test("from Personal, an agent keeps another space's board once its person says yes; from a shared one, it can't", async () => {
  const rt = await start(stores.memory);
  try {
    const { space: personal } = await rt.call<{ space: string }>("space.personal", {}, {
      actor: ana,
    });
    const { space: launch } = await rt.call<{ space: string }>("space.create", { name: "Launch" }, {
      actor: ana,
    });
    await join(rt, launch, bob, "editor", ana);
    const mine = { in: personal } as { in?: string; thread?: string };

    // From ana's Personal space, a board in Launch would show Launch's people what her work there
    // may draw on: it waits for her yes.
    const asksFirst = /^That would show Launch .* has to say yes first/;
    assert.match(
      await ask(rt, mine, "create_board", { in: launch, name: "Launch plan" }),
      asksFirst,
    );
    assert.deepEqual((await peekAs(rt, bob, launch)).boards, []);
    // With it (the agent's work there carrying her yes), it keeps Launch's board as she would,
    // for Launch's people to see.
    const approved = {
      actor: { kind: "agent", id: "north", for: ana, in: personal, approved: [launch] },
    };
    const { board } = await rt.call<{ board: string }>("board.create", {
      in: launch,
      name: "Launch plan",
    }, approved);
    await rt.call("card.create", { board, title: "Ship pricing" }, approved);
    // Reading it from there needs nothing; changing it, her yes again.
    assert.match(
      await ask(rt, mine, "list_boards", { in: launch }),
      /^1 board in that space:\n- “Launch plan” .*: 1 card/,
    );
    assert.match(
      await ask(rt, mine, "create_card", { in: launch, title: "Ship docs" }),
      asksFirst,
    );
    const seen = await peekAs(rt, bob, launch);
    assert.deepEqual(seen.cards.map((c) => [c.title, c.by]), [["Ship pricing", "agent:north"]]);

    // From a space ana shares with bob: only that space.
    const { space: team } = await rt.call<{ space: string }>("space.create", { name: "Team" }, {
      actor: ana,
    });
    await join(rt, team, bob, "editor", ana);
    assert.match(
      await ask(rt, { in: team }, "list_boards", { in: launch }),
      /You can't read the space/,
    );
  } finally {
    await rt.close();
  }
});
