/**
 * A board's columns: the ones a new board starts with, the ids new ones
 * take (from their names: `qa`, `qa-2`), finding one as people and agents
 * name it ("in review", `review`), and the stage of work a column stands
 * for, which its mark shows (Backlog's dashed ring, Done's check). Pure.
 */
import type { Column } from "../contract.ts";
import { invalid } from "./errors.ts";

/** What a new board starts with: the team's usual flow. */
export const DEFAULT_COLUMNS: readonly Column[] = [
  { id: "backlog", name: "Backlog" },
  { id: "todo", name: "To do" },
  { id: "doing", name: "Doing" },
  { id: "blocked", name: "Blocked" },
  { id: "review", name: "In review" },
  { id: "done", name: "Done" },
];

/** At most this many columns on a board. */
export const MOST_COLUMNS = 20;

/** Text as it's matched: any case, any accents, spaces and dashes alike. */
export const fold = (text: string) =>
  text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[\s_-]+/g, " ")
    .trim();

/** A new column's id, from its name, free among `taken`: `qa`, then `qa-2`. */
export function columnId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = fold(name).replace(/[^a-z0-9 ]+/g, "").trim().replace(/ +/g, "-").slice(0, 24) ||
    "column";
  for (let n = 1;; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!used.has(id)) return id;
  }
}

/** Columns from their names alone (a new board's own), each with an id. */
export function columnsNamed(names: string[]): Column[] {
  const columns: Column[] = [];
  for (const name of names) {
    columns.push({ id: columnId(name, columns.map((c) => c.id)), name: name.trim() });
  }
  return columns;
}

/** The column `named` is: by its id, or its name in any case. */
export const columnOf = (columns: readonly Column[], named: string): Column | undefined =>
  columns.find((c) => c.id === named) ??
    columns.find((c) => fold(c.name) === fold(named)) ??
    columns.find((c) => fold(c.id) === fold(named));

/** A column's stage of work, as its mark shows it. */
export type Stage = "backlog" | "todo" | "doing" | "blocked" | "review" | "done";

/** What a column stands for, from its id or its name: Doing is under way, Done is done. */
export function stageOf(column: Column): Stage {
  const said = `${fold(column.id)} ${fold(column.name)}`;
  if (/\b(done|shipped|complete|completed|closed|finished|live)\b/.test(said)) return "done";
  if (/\b(blocked|stuck|waiting|on hold|hold)\b/.test(said)) return "blocked";
  if (/\b(review|reviewing|qa|testing|test|verify|approval)\b/.test(said)) return "review";
  if (/\b(doing|progress|active|started|working|wip)\b/.test(said)) return "doing";
  if (/\b(backlog|later|ideas?|someday|icebox|inbox)\b/.test(said)) return "backlog";
  return "todo";
}

/** What changing a board's columns does: those it keeps, adds and removes. */
export type ColumnChange = { columns: Column[]; added: Column[]; removed: Column[] };

/**
 * A board's columns as given (`[{ id?, name }]`, in their new order): known
 * ids are kept (renamed, moved), the rest are new and get ids; those left
 * out are removed. Throws, in words, on what can't be: no columns, too many,
 * an empty name, or two with one name.
 */
export function changeColumns(
  was: readonly Column[],
  given: { id?: string; name: string }[],
): ColumnChange {
  if (!given.length) throw invalid("A board needs at least one column.");
  if (given.length > MOST_COLUMNS) throw invalid(`A board has at most ${MOST_COLUMNS} columns.`);
  const known = new Set(was.map((c) => c.id));
  const columns: Column[] = [];
  const added: Column[] = [];
  for (const { id, name } of given) {
    const trimmed = name.trim();
    if (!trimmed) throw invalid("Each column needs a name.");
    if (columns.some((c) => fold(c.name) === fold(trimmed))) {
      throw invalid(`There's already a column called “${trimmed}”.`);
    }
    if (id && known.has(id) && !columns.some((c) => c.id === id)) {
      columns.push({ id, name: trimmed });
      continue;
    }
    const column = {
      id: columnId(trimmed, [...known, ...columns.map((c) => c.id)]),
      name: trimmed,
    };
    columns.push(column);
    added.push(column);
  }
  const removed = was.filter((c) => !columns.some((kept) => kept.id === c.id));
  return { columns, added, removed };
}
