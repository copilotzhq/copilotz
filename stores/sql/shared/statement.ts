/**
 * One SQL statement, as maintenance runs it (a store's `inspect`, and its
 * transactions' `execute`): exactly one, and none that would end the
 * transaction it runs in, or change its connection beyond it.
 *
 * PostgreSQL runs every statement of a query sent without parameters, and
 * SQLite runs the first and drops the rest, so a statement is read here
 * first, as its database reads it: strings, quoted names and comments are
 * skipped (PostgreSQL's `E'…'` escapes and `$tag$…$tag$` bodies too), and a
 * `;` outside them may only end it. A SQLite trigger's body (`BEGIN …; END`)
 * is therefore more than one: make triggers elsewhere.
 */
import { invalid } from "../../../runtime/errors.ts";

export type Dialect = "postgres" | "sqlite";

/** What reading or writing it does: a write may change the database, never the connection. */
export type Mode = "read" | "write";

/** Statements that end or nest transactions: they'd take the statement out of its own. */
const TRANSACTIONS = new Set([
  "BEGIN",
  "START",
  "COMMIT",
  "END",
  "ROLLBACK",
  "ABORT",
  "SAVEPOINT",
  "RELEASE",
]);

/** Statements whose effect outlives the transaction, on a connection other work shares. */
const SESSION: Record<Dialect, Set<string>> = {
  postgres: new Set([
    "PREPARE",
    "DEALLOCATE",
    "SET",
    "RESET",
    "DISCARD",
    "LISTEN",
    "UNLISTEN",
    "LOAD",
    "DECLARE",
    "FETCH",
    "MOVE",
    "CLOSE",
    "COPY",
    "VACUUM",
  ]),
  sqlite: new Set(["ATTACH", "DETACH", "VACUUM"]),
};

const word = /[A-Za-z_][A-Za-z0-9_$]*/y;
const identifier = /[A-Za-z0-9_$\u0080-￿]/;
const tag = /\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;

/**
 * The statement in `sql`, checked: its text without the `;` that ends it
 * (and whatever follows), and its first keyword, uppercased. Throws
 * `invalid` for none, more than one, or one maintenance can't run.
 */
export function statement(
  sql: string,
  dialect: Dialect,
  mode: Mode,
): { text: string; keyword: string } {
  if (typeof sql !== "string") throw invalid("The statement is SQL text.");
  const postgres = dialect === "postgres";
  let i = 0;
  let keyword = "";
  let end: number | undefined;
  const unterminated = (what: string) => invalid(`The statement has an unterminated ${what}.`);
  /** Skips a comment at `i`; false when there's none. */
  const comment = () => {
    if (sql.startsWith("--", i)) {
      const line = sql.indexOf("\n", i);
      i = line < 0 ? sql.length : line + 1;
      return true;
    }
    if (!sql.startsWith("/*", i)) return false;
    // PostgreSQL's block comments nest; SQLite's don't.
    let depth = 0;
    do {
      if (sql.startsWith("/*", i)) (depth++, i += 2);
      else if (sql.startsWith("*/", i)) (depth = postgres ? depth - 1 : 0, i += 2);
      else if (i >= sql.length) throw unterminated("comment");
      else i++;
    } while (depth > 0);
    return true;
  };
  /** Skips text quoted by `close` from i (just past the opening), a doubled `close` inside it. */
  const quoted = (close: string, what: string, backslashes = false) => {
    for (;;) {
      if (i >= sql.length) throw unterminated(what);
      const c = sql[i++];
      if (backslashes && c === "\\") i++;
      else if (c === close) {
        if (sql[i] !== close || close === "]") return;
        i++;
      }
    }
  };
  while (i < sql.length && end === undefined) {
    const c = sql[i];
    const before = sql[i - 1] ?? "";
    if (comment()) continue;
    if (c === "'") {
      // E'…' takes backslash escapes, in PostgreSQL; a plain string doesn't.
      const escaped = postgres && /[eE]/.test(before) && !identifier.test(sql[i - 2] ?? "");
      i++;
      quoted("'", "string", escaped);
    } else if (c === '"') (i++, quoted('"', "quoted name"));
    else if (!postgres && c === "`") (i++, quoted("`", "quoted name"));
    else if (!postgres && c === "[") (i++, quoted("]", "quoted name"));
    else if (postgres && c === "$" && !identifier.test(before)) {
      tag.lastIndex = i;
      const open = tag.exec(sql)?.[0];
      if (!open) i++; // A parameter ($1), not a body.
      else {
        const close = sql.indexOf(open, i + open.length);
        if (close < 0) throw unterminated(`${open} body`);
        i = close + open.length;
      }
    } else if (c === ";") end = i;
    else {
      word.lastIndex = i;
      const found = !identifier.test(before) && word.exec(sql)?.[0];
      if (found) {
        keyword ||= found.toUpperCase();
        i += found.length;
      } else i++;
    }
  }
  if (end !== undefined) {
    // Only space and comments may follow the statement's `;`.
    for (i = end + 1; i < sql.length;) {
      if (/\s/.test(sql[i])) i++;
      else if (!comment()) {
        throw invalid("One statement at a time: send each on its own.");
      }
    }
  }
  if (!keyword) throw invalid("There's no statement to run.");
  if (TRANSACTIONS.has(keyword)) {
    throw invalid(
      `${keyword} can't run here: the statement runs in a transaction of its own, which ` +
        `commits it (or rolls it back) as a whole.`,
    );
  }
  if (SESSION[dialect].has(keyword) || (mode === "write" && !postgres && keyword === "PRAGMA")) {
    throw invalid(
      `${keyword} can't run here: it would change the connection, which the store's other ` +
        `work shares, beyond this statement.`,
    );
  }
  return { text: sql.slice(0, end ?? sql.length), keyword };
}
