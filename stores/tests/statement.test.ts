/**
 * Maintenance SQL is one statement, read as its database reads it: a `;`
 * inside a string, a quoted name, a comment or a PostgreSQL body doesn't end
 * it, one outside does, and statements that would end its transaction or
 * outlive it on the connection are refused.
 */
import { assertEquals, assertThrows } from "@std/assert";
import { statement } from "../sql/shared/statement.ts";
import { test } from "../../testing/mod.ts";

const refused = (sql: string, dialect: "postgres" | "sqlite" = "postgres", mode = "write") =>
  assertThrows(() => statement(sql, dialect, mode as "read" | "write"), Error);

test("statement: one, without its `;` and what follows it", () => {
  assertEquals(statement("SELECT 1", "postgres", "read"), { text: "SELECT 1", keyword: "SELECT" });
  assertEquals(statement("  select 1 ;  -- done\n /* end */ ", "postgres", "read"), {
    text: "  select 1 ",
    keyword: "SELECT",
  });
  assertEquals(statement("-- why\nUPDATE t SET a = 1", "sqlite", "write").keyword, "UPDATE");
  assertEquals(
    statement("/* a /* nested */ one */ WITH x AS (SELECT 1) SELECT * FROM x", "postgres", "read")
      .keyword,
    "WITH",
  );
  assertEquals(statement("(SELECT 1) UNION (SELECT 2)", "postgres", "read").keyword, "SELECT");
});

test("statement: a `;` in a string, a name, a comment or a body doesn't end it", () => {
  for (
    const sql of [
      "SELECT 'a;b'",
      "SELECT 'it''s; fine'",
      `SELECT 1 AS "a;b"`,
      "SELECT 1 -- ; not here\n",
      "SELECT 1 /* ; */",
      "SELECT $$a; b$$",
      "SELECT $fn$ ; $$ ; $fn$",
      "SELECT E'a\\'; b'",
      "SELECT $1::text, a$b FROM t WHERE x = $2",
    ]
  ) statement(sql, "postgres", "read");
  for (const sql of ["SELECT `a;b` FROM t", "SELECT [a;b] FROM t", "SELECT 'x;y'"]) {
    statement(sql, "sqlite", "read");
  }
});

test("statement: more than one is refused, however it's hidden", () => {
  refused("SELECT 1; SELECT 2");
  refused("SELECT 1;SELECT 2", "sqlite");
  refused("UPDATE t SET a = 'x'; DELETE FROM t");
  // Without E, a backslash doesn't escape: the string ends, and so does the statement.
  refused("SELECT 'a\\'; DROP TABLE t; --'");
  refused("SELECT 1 /* */ ; /* */ SELECT 2");
  // SQLite's comments don't nest: the second `*/` is outside.
  refused("SELECT 1 /* a /* b */ ; SELECT 2", "sqlite");
});

test("statement: what ends a line comment, and an E'…' string, is the database's", () => {
  // PostgreSQL ends a line comment at a CR as at an LF: what follows is a statement.
  refused("SELECT 1 -- x\r; COMMIT; DELETE FROM nodes");
  refused("SELECT 1 -- x\r\n; DELETE FROM nodes");
  // SQLite's runs to an LF: after a CR alone, it's still comment.
  assertEquals(statement("SELECT 1 -- x\r; DELETE FROM nodes", "sqlite", "read").keyword, "SELECT");
  refused("SELECT 1 -- x\n; DELETE FROM nodes", "sqlite");
  // An E'…' string continued in a quote on a later line keeps its escapes there.
  refused("SELECT E'a'\n'\\'' ; DELETE FROM nodes; --'");
  refused("SELECT E'a' -- note\n  '\\'' ; DELETE FROM nodes; --'");
  assertEquals(statement("SELECT E'a'\n'b\\'c'", "postgres", "read").keyword, "SELECT");
  // After a number, `$$` opens a body (as the server reads it): what it holds is a string.
  refused("SELECT 1$$ ' $$; SELECT 2 --'");
  assertEquals(statement("SELECT a$b, $1 FROM t", "postgres", "read").keyword, "SELECT");
  // A plain string's continuation has no escapes: `''` in it is a quote, so this is one string.
  assertEquals(
    statement("SELECT 'a'\n'\\'' ; DELETE FROM nodes; --'", "postgres", "read").keyword,
    "SELECT",
  );
});

test("statement: nothing, or something unterminated, is refused", () => {
  // Parentheses balance (a read's limit wraps it in a pair of its own).
  refused("SELECT 1 AS v) UNION ALL SELECT 2 AS v FROM (SELECT 1", "sqlite", "read");
  refused("SELECT (1", "postgres", "read");
  assertEquals(statement("SELECT ')(' AS p, (1) AS one -- )", "sqlite", "read").keyword, "SELECT");
  refused("");
  refused("  -- only a comment\n");
  refused(";");
  refused("SELECT 'open");
  refused('SELECT "open');
  refused("SELECT $$ open");
  refused("SELECT 1 /* open");
});

test("statement: what would end its transaction or outlive it is refused", () => {
  for (
    const sql of [
      "BEGIN",
      "commit",
      "ROLLBACK",
      "END",
      "SAVEPOINT a",
      "RELEASE a",
      "START TRANSACTION",
    ]
  ) {
    refused(sql, "postgres", "read");
    refused(sql, "postgres", "write");
  }
  for (
    const sql of [
      "SET search_path = x",
      "RESET ALL",
      "DISCARD ALL",
      "LISTEN x",
      "PREPARE p AS SELECT 1",
      "COPY t TO STDOUT",
      "DECLARE c CURSOR FOR SELECT 1",
      "VACUUM",
    ]
  ) {
    refused(sql, "postgres", "write");
  }
  for (const sql of ["BEGIN", "COMMIT", "ATTACH 'x' AS y", "DETACH y", "VACUUM"]) {
    refused(sql, "sqlite");
  }
  // A pragma reads in SQLite, on the reading connection; it never writes.
  assertEquals(statement("PRAGMA table_info(nodes)", "sqlite", "read").keyword, "PRAGMA");
  refused("PRAGMA journal_mode = DELETE", "sqlite", "write");
});
