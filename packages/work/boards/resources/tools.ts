/**
 * Boards, for agents, wherever their conversation is in a space: that
 * space's boards. `list_boards`, `read_board` (one by name or id, or the
 * space's first: its columns and their cards, each with its id),
 * `create_board`, `create_card`, `update_card` and `move_card`. They call
 * the boards' Actions as the agent working for its person, so the rules
 * keep them to that space and to what both may do there. People and agents
 * are named as people say them (`me`, "North", an email), matched against
 * who's in the space. Answers are short and name the board with its link.
 */
import { namesFor } from "copilotz/plugins/access/contract";
import {
  type Thread,
  type Tool,
  tool,
  type ToolContext,
  workIn,
} from "copilotz/plugins/agents/contract";
import type { Board, Card, Column } from "../contract.ts";
import { columnOf, fold, stageOf } from "../shared/columns.ts";
import { dueSaid, todayOf } from "../shared/dates.ts";
import { byOrder } from "../shared/order.ts";
import { assigneeSaid, everyone, peopleIn, shown, type Someone, whoIs } from "../shared/people.ts";
import { cardNamed, named, onBoard } from "../shared/said.ts";

type Ctx = ToolContext;

const inSpace = (_agent: string, thread: Thread) => !!thread.in;

/** Each tool works here, or in another space its work reaches. */
const ELSEWHERE = " In another space you can work in, give in (its id).";

/** At most `most` characters of `text`, on one line. */
const gist = (text: string | undefined, most = 160) => {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > most ? `${flat.slice(0, most - 1).trimEnd()}…` : flat;
};

/** The space's boards, oldest first. */
const boardsOf = async (ctx: Ctx, space: string) =>
  await ctx.db.collection<Board>("board").find({ in: space }, { sort: { at: 1 } });

/** The board `typed` names (its id or name), or the space's first in use; else why not. */
async function boardNamed(ctx: Ctx, space: string, typed?: string): Promise<Board | string> {
  const boards = await boardsOf(ctx, space);
  const active = boards.filter((b) => !b.archived);
  const asked = typed?.trim();
  if (!asked) {
    return active[0] ??
      (boards.length
        ? `This space's boards are all archived: ${boards.map(named).join(", ")}.`
        : "There's no board in this space yet: make one with create_board.");
  }
  const found = boards.find((b) => b._id === asked) ??
    boards.find((b) => fold(b.name) === fold(asked)) ??
    (() => {
      const close = boards.filter((b) => fold(b.name).includes(fold(asked)));
      return close.length === 1 ? close[0] : undefined;
    })();
  if (found) return found;
  return `No board “${asked}” in this space.` +
    (boards.length ? ` Its boards: ${boards.map(named).join(", ")}.` : " It has none yet.");
}

/** The card `typed` names (its id, or its title) in the space, on `board` if given; else why not. */
async function cardFound(
  ctx: Ctx,
  space: string,
  typed: string,
  board?: Board,
): Promise<{ card: Card; board: Board } | string> {
  const cards = ctx.db.collection<Card>("card");
  const asked = typed.trim().replace(/^\[|\]$/g, "");
  let card = await cards.findOne({ _id: asked, in: space });
  if (!card) {
    const all = await cards.find({ in: space, ...(board ? { board: board._id } : {}) });
    const exact = all.filter((c) => fold(c.title) === fold(asked));
    const close = exact.length ? exact : all.filter((c) => fold(c.title).includes(fold(asked)));
    if (close.length > 1) {
      return `Several cards match “${asked}”: ` +
        close.slice(0, 6).map((c) => cardNamed(c)).join(", ") + ". Say which by its id.";
    }
    card = close[0] ?? null;
  }
  if (!card) return `No card “${asked}” here. read_board lists the cards with their ids.`;
  const its = board?._id === card.board
    ? board
    : await ctx.db.collection<Board>("board").findOne({ _id: card.board });
  return its ? { card, board: its } : "That card's board is gone.";
}

/** The column `typed` names on `board`, or why not. */
function columnNamed(board: Board, typed: string): Column | string {
  return columnOf(board.columns, typed) ??
    `“${board.name}” has no column “${typed}”. Its columns: ${
      board.columns.map((c) => c.name).join(", ")
    }.`;
}

/** Who `typed` is in the space (`me`, a name, an email), or why not. */
function someoneNamed(typed: string, people: Someone[], agent: string): Someone | string {
  const found = whoIs(typed, people, agent);
  if ("found" in found) return found.found;
  if ("several" in found) {
    return `“${typed}” could be ${found.several.map(shown).join(" or ")}: say which.`;
  }
  return `Nobody called “${typed}” is in this space. Here: ${everyone(people)}.`;
}

/** Whether a value asks to clear a field: null, or nothing. */
const clears = (value: unknown) =>
  value === null || value === "" || (Array.isArray(value) && !value.length) ||
  (typeof value === "string" && ["none", "nobody", "unassigned"].includes(fold(value)));

/** An Action's refusal, as an agent is told it. */
function refused(error: unknown): string {
  const { code, message } = error as { code?: string; message?: string };
  if (code === "forbidden") {
    return "You can read this board, but you can't change it here: ask someone who manages " +
      "the space to make you an editor.";
  }
  return message || String(error);
}

/** A card as `read_board` lists it: id, title, owner, labels, due, a line of what it says. */
function cardLine(
  card: Card,
  people: Someone[],
  today: string,
  done: boolean,
  names: Record<string, string>,
): string {
  const parts = [
    `- [${card._id}] ${card.title}`,
    assigneeSaid(card.assignee, people, names),
    ...(card.labels?.length ? [`labels: ${card.labels.join(", ")}`] : []),
    ...(card.due ? [dueSaid(card.due, today, done)] : []),
  ];
  const about = gist(card.description);
  return parts.join(" · ") + (about ? `\n  ${about}` : "");
}

const listBoards = tool({
  offer: inSpace,
  description: "List the boards in this conversation's space: each one's name, link, and how " +
    "many cards are in each column. Read one with read_board." + ELSEWHERE,
  input: {
    type: "object",
    properties: {
      in: { type: "string", description: "Another space, by its id (your context lists them)." },
    },
  },
  run: async (input, ctx) => {
    const where = await workIn(ctx, input.in, "read");
    if (typeof where === "string") return where;
    const space = where.in;
    const boards = await boardsOf(ctx, space);
    if (!boards.length) return "No boards in this space yet. Make one with create_board.";
    const cards = await ctx.db.collection<Card>("card").find({ in: space });
    const line = (b: Board) => {
      const n = (column: string) =>
        cards.filter((c) => c.board === b._id && c.column === column).length;
      const total = b.columns.reduce((sum, c) => sum + n(c.id), 0);
      const columns = b.columns.filter((c) => n(c.id)).map((c) => `${c.name} ${n(c.id)}`);
      return `- ${named(b)}: ` +
        (total
          ? `${total} card${total === 1 ? "" : "s"} (${columns.join(", ")})`
          : "no cards yet") +
        (b.description ? `. ${gist(b.description, 120)}` : "");
    };
    const active = boards.filter((b) => !b.archived);
    const archived = boards.filter((b) => b.archived);
    return [
      `${active.length} board${active.length === 1 ? "" : "s"} in ${
        space === ctx.in ? "this" : "that"
      } space:`,
      ...active.map(line),
      ...(archived.length ? ["Archived:", ...archived.map(line)] : []),
    ].join("\n");
  },
});

const readBoard = tool({
  offer: inSpace,
  description: "Read a board in this space (by its name or id; without one, the space's " +
    "first): its columns in order, with their cards, each with its id, title, owner, labels, " +
    "due date and a line of its description. Read it before you change it." + ELSEWHERE,
  input: {
    type: "object",
    properties: {
      in: { type: "string", description: "Another space, by its id (your context lists them)." },
      board: { type: "string", description: "Its name or id." },
    },
  },
  run: async ({ board: typed, in: there }, ctx) => {
    const where = await workIn(ctx, there, "read");
    if (typeof where === "string") return where;
    const space = where.in;
    const board = await boardNamed(ctx, space, typed);
    if (typeof board === "string") return board;
    const [cards, people] = await Promise.all([
      ctx.db.collection<Card>("card").find({ in: space, board: board._id }),
      peopleIn(ctx, space),
    ]);
    // Cards' owners since gone from the space: by their names still.
    const gone = await namesFor(
      ctx,
      cards.flatMap((c) =>
        c.assignee?.startsWith("person:") && !people.some((p) => p.key === c.assignee)
          ? [c.assignee]
          : []
      ),
    );
    const today = todayOf();
    const sections = board.columns.map((column) => {
      const here = byOrder(cards.filter((c) => c.column === column.id));
      const done = stageOf(column) === "done";
      return [
        `## ${column.name} (${here.length})`,
        ...(here.length ? here.map((c) => cardLine(c, people, today, done, gone)) : ["(empty)"]),
      ].join("\n");
    });
    // Cards in a column the board no longer has (shouldn't happen): shown, not lost.
    const lost = cards.filter((c) => !board.columns.some((col) => col.id === c.column));
    return [
      `Board ${named(board)}: ${board.columns.length} columns, ${cards.length} card${
        cards.length === 1 ? "" : "s"
      }${board.archived ? " (archived)" : ""}.`,
      ...(board.description ? [`About: ${gist(board.description, 600)}`] : []),
      "",
      ...sections,
      ...(lost.length
        ? ["## (no column)", ...lost.map((c) => cardLine(c, people, today, false, gone))]
        : []),
    ].join("\n");
  },
});

const createBoard = tool({
  offer: inSpace,
  description: "Make a board in this space, for work that takes more than one step. It starts " +
    "with Backlog, To do, Doing, Blocked, In review and Done, unless you name its columns." +
    ELSEWHERE,
  input: {
    type: "object",
    properties: {
      in: { type: "string", description: "Another space, by its id (your context lists them)." },
      name: { type: "string", minLength: 1, maxLength: 80 },
      description: { type: "string", description: "What it's for, in a line or two." },
      columns: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 40 },
        description: "Its columns' names, left to right (only if the usual ones don't fit).",
      },
    },
    required: ["name"],
  },
  run: async ({ name, description, columns, in: there }, ctx) => {
    const where = await workIn(ctx, there, "write");
    if (typeof where === "string") return where;
    const space = where.in;
    try {
      const made = await ctx.call<{ board: string; name: string; columns: Column[] }>(
        "board.create",
        {
          in: space,
          name,
          ...(description ? { description } : {}),
          ...(columns?.length ? { columns } : {}),
        },
      );
      return `Made the board ${named({ _id: made.board, name: made.name })}, with columns ` +
        `${made.columns.map((c) => c.name).join(", ")}. Add cards with create_card.`;
    } catch (error) {
      return refused(error);
    }
  },
});

const createCard = tool({
  offer: inSpace,
  description: "Add a card to a board in this space: one real outcome, with its owner " +
    "(assignee), what done looks like and any blocker in its description, and an honest " +
    "column. The board is the space's first unless you name one; the column, its first." +
    ELSEWHERE,
  input: {
    type: "object",
    properties: {
      in: { type: "string", description: "Another space, by its id (your context lists them)." },
      title: { type: "string", minLength: 1, maxLength: 300 },
      board: { type: "string", description: "The board's name or id." },
      column: { type: "string", description: "The column's name or id." },
      description: {
        type: "string",
        description: "Markdown: the outcome, how we'll know it's done, any blocker.",
      },
      assignee: {
        type: "string",
        description: "Who owns it: me (you), an agent's name, or a person's name or email.",
      },
      labels: { type: "array", items: { type: "string", minLength: 1, maxLength: 32 } },
      due: { type: "string", description: "YYYY-MM-DD" },
      at: {
        type: "string",
        enum: ["top", "bottom"],
        description: "Where in the column (the bottom by default).",
      },
    },
    required: ["title"],
  },
  run: async (input, ctx) => {
    const where = await workIn(ctx, input.in, "write");
    if (typeof where === "string") return where;
    const space = where.in;
    const board = await boardNamed(ctx, space, input.board);
    if (typeof board === "string") return board;
    const column = input.column ? columnNamed(board, input.column) : board.columns[0];
    if (typeof column === "string") return column;
    let owner: Someone | undefined;
    if (input.assignee && !clears(input.assignee)) {
      const found = someoneNamed(input.assignee, await peopleIn(ctx, space), ctx.agent);
      if (typeof found === "string") return found;
      owner = found;
    }
    try {
      const made = await ctx.call<{ card: string; title: string }>("card.create", {
        board: board._id,
        title: input.title,
        column: column.id,
        ...(input.at ? { at: input.at } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(owner ? { assignee: owner.key } : {}),
        ...(input.labels?.length ? { labels: input.labels } : {}),
        ...(input.due ? { due: input.due } : {}),
      });
      const card = { _id: made.card, title: made.title };
      return onBoard(
        `Created ${cardNamed(card)} in ${column.name}${owner ? `, for ${shown(owner)}` : ""}`,
        board,
      );
    } catch (error) {
      return refused(error);
    }
  },
});

const updateCard = tool({
  offer: inSpace,
  description: "Change a card in this space (by its id from read_board, or its title): its " +
    "title, description, assignee, labels (the whole set) or due date. An empty value, or " +
    "null, clears one. Moving it is move_card." + ELSEWHERE,
  input: {
    type: "object",
    properties: {
      in: { type: "string", description: "Another space, by its id (your context lists them)." },
      card: { type: "string", description: "Its id, or its title." },
      board: { type: "string", description: "The board's name or id, if the title is on several." },
      title: { type: "string", minLength: 1, maxLength: 300 },
      description: { type: ["string", "null"], description: "Markdown; replaces what it says." },
      assignee: {
        type: ["string", "null"],
        description: "me, an agent's name, a person's name or email; empty to unassign.",
      },
      labels: { type: ["array", "null"], items: { type: "string", maxLength: 32 } },
      due: { type: ["string", "null"], description: "YYYY-MM-DD; empty to clear." },
    },
    required: ["card"],
  },
  run: async (input, ctx) => {
    const where = await workIn(ctx, input.in, "write");
    if (typeof where === "string") return where;
    const space = where.in;
    const board = input.board ? await boardNamed(ctx, space, input.board) : undefined;
    if (typeof board === "string") return board;
    const found = await cardFound(ctx, space, input.card, board);
    if (typeof found === "string") return found;
    const change: Record<string, unknown> = {};
    const said: string[] = [];
    if (input.title !== undefined && input.title.trim() !== found.card.title) {
      change.title = input.title;
      said.push(`titled “${input.title.trim()}”`);
    }
    if (input.description !== undefined) {
      change.description = clears(input.description) ? null : input.description;
      said.push(change.description === null ? "description cleared" : "description written");
    }
    if (input.assignee !== undefined) {
      if (clears(input.assignee)) {
        change.assignee = null;
        said.push("unassigned");
      } else {
        const owner = someoneNamed(input.assignee!, await peopleIn(ctx, space), ctx.agent);
        if (typeof owner === "string") return owner;
        change.assignee = owner.key;
        said.push(`assigned to ${shown(owner)}`);
      }
    }
    if (input.labels !== undefined) {
      change.labels = clears(input.labels) ? null : input.labels;
      said.push(change.labels === null ? "labels cleared" : `labels ${input.labels!.join(", ")}`);
    }
    if (input.due !== undefined) {
      change.due = clears(input.due) ? null : input.due;
      said.push(change.due === null ? "due date cleared" : `due ${input.due}`);
    }
    if (!said.length) return `Nothing to change on ${cardNamed(found.card)}.`;
    try {
      await ctx.call("card.update", { card: found.card._id, ...change });
      return onBoard(
        `Updated ${cardNamed({ ...found.card, title: input.title?.trim() || found.card.title })}: ${
          said.join(", ")
        }`,
        found.board,
      );
    } catch (error) {
      return refused(error);
    }
  },
});

const moveCard = tool({
  offer: inSpace,
  description: "Move a card in this space (by its id from read_board, or its title) to a " +
    "column of its board, by the column's name or id: when its state changes, not later. At " +
    "the column's bottom unless you say top." + ELSEWHERE,
  input: {
    type: "object",
    properties: {
      in: { type: "string", description: "Another space, by its id (your context lists them)." },
      card: { type: "string", description: "Its id, or its title." },
      column: { type: "string", description: "The column's name or id." },
      board: { type: "string", description: "The board's name or id, if the title is on several." },
      at: { type: "string", enum: ["top", "bottom"] },
    },
    required: ["card", "column"],
  },
  run: async (input, ctx) => {
    const where = await workIn(ctx, input.in, "write");
    if (typeof where === "string") return where;
    const space = where.in;
    const board = input.board ? await boardNamed(ctx, space, input.board) : undefined;
    if (typeof board === "string") return board;
    const found = await cardFound(ctx, space, input.card, board);
    if (typeof found === "string") return found;
    const column = columnNamed(found.board, input.column);
    if (typeof column === "string") return column;
    const from = found.board.columns.find((c) => c.id === found.card.column);
    try {
      await ctx.call("card.move", {
        card: found.card._id,
        column: column.id,
        at: input.at ?? "bottom",
      });
      const head = from?.id === column.id
        ? `Moved ${cardNamed(found.card)} to the ${input.at ?? "bottom"} of ${column.name}`
        : `Moved ${cardNamed(found.card)} from ${from?.name ?? "nowhere"} to ${column.name}` +
          (input.at === "top" ? " (at the top)" : "");
      return onBoard(head, found.board);
    } catch (error) {
      return refused(error);
    }
  },
});

export const tools: Record<string, Tool> = {
  list_boards: listBoards,
  read_board: readBoard,
  create_board: createBoard,
  create_card: createCard,
  update_card: updateCard,
  move_card: moveCard,
};
