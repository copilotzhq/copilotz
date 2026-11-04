/**
 * One SQL statement, as maintenance runs it (a store's `inspect`, and its
 * transactions' `execute`): exactly one, and none that would end the
 * transaction it runs in, or change its connection beyond it.
 *
 * A statement is read here first, as its database's scanner reads it:
 * strings, quoted names and comments are skipped, and a `;` outside them
 * may only end it. PostgreSQL's line comments end at a CR or an LF, its
 * block comments nest, and its `E'…'` strings (and their continuations on
 * a later line) take backslash escapes, as they do once
 * `standard_conforming_strings` is on, which maintenance sets; `$tag$…$tag$`
 * bodies are skipped. SQLite's line comments end at an LF. Behind this,
 * PostgreSQL gets every maintenance statement over its extended protocol,
 * which refuses more than one, and SQLite compiles only the first. A
 * SQLite trigger's body (`BEGIN …; END`) is more than one: make triggers
 * elsewhere.
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
/**
 * PostgreSQL statements that reach past the statement, whatever the role
 * may otherwise do, and why each is refused.
 */
const OUTLIVING: Record<string, string> = {
  // A role may change its own password and settings: a login that outlives the key, or a
  // setting every later connection of it starts with.
  "ALTER ROLE": "a role's password and settings outlive the statement.",
  "ALTER USER": "a role's password and settings outlive the statement.",
  "ALTER GROUP": "a role's members outlive the statement.",
  // An anonymous block is a way around this check: whatever it runs, runs unread.
  DO: "a block runs statements of its own, which nothing here reads first.",
  // A lock holds a table against the app's own writes until the statement's transaction ends.
  LOCK: "it would hold the store's tables against the app's own writes.",
};

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
 * Whether the `$` at `at` goes on a name (`a$b`): one that starts with a
 * letter or `_`, as PostgreSQL's names do. After a number, or anything
 * else, a `$` may open a `$tag$` body.
 */
function named(sql: string, at: number): boolean {
  let start = at;
  while (start > 0 && identifier.test(sql[start - 1])) start--;
  return start < at && !/[0-9$]/.test(sql[start]);
}

/**
 * Where a PostgreSQL string continues, if it does: after its closing quote,
 * space with a line break in it (comments allowed), then a quote (the
 * scanner's `quotecontinue`). The index just past that quote, or undefined.
 */
function continued(sql: string, from: number): number | undefined {
  let i = from;
  let broke = false;
  for (;;) {
    const c = sql[i];
    if (c === "\n" || c === "\r") (broke = true, i++);
    else if (c === " " || c === "\t" || c === "\f" || (broke && c === "\v")) i++;
    else if (sql.startsWith("--", i)) {
      const line = sql.slice(i).search(/[\n\r]/);
      if (line < 0) return undefined;
      i += line;
    } else return broke && c === "'" ? i + 1 : undefined;
  }
}

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
  /** The statement's first two words, uppercased: what it is (`ALTER ROLE`). */
  const words: string[] = [];
  let end: number | undefined;
  /** Parentheses open outside strings and comments: they balance, or it's no statement. */
  let depth = 0;
  const unterminated = (what: string) => invalid(`The statement has an unterminated ${what}.`);
  /** Skips a comment at `i`; false when there's none. */
  const comment = () => {
    if (sql.startsWith("--", i)) {
      // PostgreSQL ends a line comment at either; SQLite only at an LF.
      const line = sql.slice(i).search(postgres ? /[\n\r]/ : /\n/);
      i = line < 0 ? sql.length : i + line + 1;
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
      // An E'…' string goes on in a quote after a line break, escapes and all.
      for (let next; escaped && (next = continued(sql, i)) !== undefined;) {
        i = next;
        quoted("'", "string", true);
      }
    } else if (c === '"') (i++, quoted('"', "quoted name"));
    else if (!postgres && c === "`") (i++, quoted("`", "quoted name"));
    else if (!postgres && c === "[") (i++, quoted("]", "quoted name"));
    else if (postgres && c === "$" && !named(sql, i)) {
      tag.lastIndex = i;
      const open = tag.exec(sql)?.[0];
      if (!open) i++; // A parameter ($1), not a body.
      else {
        const close = sql.indexOf(open, i + open.length);
        if (close < 0) throw unterminated(`${open} body`);
        i = close + open.length;
      }
    } else if (c === ";") end = i;
    else if (c === "(") (depth++, i++);
    else if (c === ")") {
      if (--depth < 0) throw invalid("The statement closes a parenthesis it never opened.");
      i++;
    } else {
      word.lastIndex = i;
      const found = !identifier.test(before) && word.exec(sql)?.[0];
      if (found) {
        keyword ||= found.toUpperCase();
        if (words.length < 2) words.push(found.toUpperCase());
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
  if (depth) throw invalid("The statement leaves a parenthesis open.");
  if (postgres) {
    const what = OUTLIVING[keyword] ? keyword : words.join(" ");
    const said = OUTLIVING[what];
    if (said) throw invalid(`${what} can't run here: ${said}`);
  }
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
