/**
 * A maintenance read of a SQLite file, apart: in a child process of this
 * same runtime (Deno, Node or Bun), on a read-only connection of its own.
 * SQLite runs a statement synchronously and can't be stopped from another
 * thread, so on the store's connection, or in a worker, a long one would go
 * on burning a core and holding the WAL however long it takes. A process
 * is killed at the read's timeout, statement and all: the process goes on,
 * the read answers at its timeout, and nothing it set (a pragma, a
 * temporary object) outlives it. Its rows come back within `bytes`.
 *
 * It needs to start a process of this runtime (`process.execPath`; on
 * Deno, permission to run it): where it can't, the read says `unstarted`,
 * and the store reads on its own connection instead.
 */
import { failure } from "../../../runtime/errors.ts";

/** Not literal, so no bundler resolves them where there are no processes. */
const CHILDREN = "node:child_process";
const PROCESS = "node:process";

type Child = {
  stdin: { end(data: string): void };
  stdout: { on(event: "data", listener: (chunk: Uint8Array) => void): void };
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: (code: number | null) => void): void;
  kill(signal: string): void;
};
type Spawn = (command: string, args: string[], options: { stdio: string[] }) => Child;

/** The read, in the child: reads its request from stdin, answers on stdout. */
const CODE = `
import process from "node:process";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const bytesOf = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const base64 = (bytes) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
};
const revive = (_key, value) =>
  value && typeof value === "object" && typeof value.$bytes === "string" ? bytesOf(value.$bytes)
  : value && typeof value === "object" && typeof value.$bigint === "string" ? BigInt(value.$bigint)
  : value;
const plain = (_key, value) =>
  typeof value === "bigint" ? { $bigint: value.toString() }
  : value instanceof Uint8Array ? { $bytes: base64(value) }
  : value;
const { path, sql, params, bytes } = JSON.parse(input, revive);
let db;
try {
  if ("Bun" in globalThis) {
    const { Database } = await import("bun:sqlite");
    db = new Database(path, { readonly: true });
  } else {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(path, { readOnly: true });
  }
  db.exec("PRAGMA query_only = 1");
  const rows = [];
  let used = 0;
  for (const row of db.prepare(sql).all(...params)) {
    const text = JSON.stringify({ ...row }, plain);
    rows.push(text);
    used += new TextEncoder().encode(text).length + 1;
    if (bytes !== null && used > bytes) break;
  }
  process.stdout.write('{"rows":[' + rows.join(",") + "]}");
} catch (error) {
  process.stdout.write(JSON.stringify({
    error: { message: String(error?.message ?? error), errcode: error?.errcode ?? error?.errno },
  }));
} finally {
  try { db?.close(); } catch {}
}
`;

/** How this runtime evaluates a module given as text. */
const evaluating = () =>
  "Deno" in globalThis
    ? ["eval", "--quiet", "--no-config", CODE]
    : "Bun" in globalThis
    ? ["-e", CODE]
    : ["--no-warnings", "--input-type=module", "-e", CODE];

/** A process that couldn't start here (no processes, no permission): then no read runs apart. */
const unstarted = (cause: unknown) =>
  Object.assign(new Error("The read's process didn't start."), { code: "unstarted", cause });

const base64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
};
const plain = (_key: string, value: unknown) =>
  typeof value === "bigint"
    ? { $bigint: value.toString() }
    : value instanceof Uint8Array
    ? { $bytes: base64(value) }
    : value;
const revive = (_key: string, value: unknown) => {
  const it = value as { $bytes?: unknown; $bigint?: unknown } | null;
  if (it && typeof it === "object" && typeof it.$bytes === "string") {
    return Uint8Array.from(atob(it.$bytes), (c) => c.charCodeAt(0));
  }
  if (it && typeof it === "object" && typeof it.$bigint === "string") return BigInt(it.$bigint);
  return value;
};

let started: Promise<{ spawn: Spawn; execPath: string } | undefined> | undefined;

/**
 * Runs `sql` on `path`, read-only, in a child process; rejects with what
 * SQLite said (`errcode`), `timeout` after `timeout` ms (the process
 * killed), or `unstarted`.
 */
export async function readApart(
  path: string,
  sql: string,
  params: unknown[],
  options: { timeout?: number; bytes?: number } = {},
): Promise<Record<string, unknown>[]> {
  const here = await (started ??= Promise.all([import(CHILDREN), import(PROCESS)]).then(
    ([children, process]) => ({
      spawn: children.spawn as Spawn,
      execPath: (process.default ?? process).execPath as string,
    }),
    () => undefined,
  ));
  if (!here) throw unstarted(undefined);
  let child: Child;
  try {
    child = here.spawn(here.execPath, evaluating(), { stdio: ["pipe", "pipe", "ignore"] });
  } catch (error) {
    throw unstarted(error);
  }
  const { timeout, bytes } = options;
  return await new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (done: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done();
    };
    child.on("error", (error) => settle(() => reject(unstarted(error))));
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("close", (code) =>
      settle(() => {
        const text = new TextDecoder().decode(
          chunks.reduce((all, chunk) => {
            const joined = new Uint8Array(all.length + chunk.length);
            joined.set(all);
            joined.set(chunk, all.length);
            return joined;
          }, new Uint8Array()),
        );
        let answer: { rows?: Record<string, unknown>[]; error?: { message: string } };
        try {
          answer = JSON.parse(text, revive);
        } catch {
          return reject(new Error(`The read's process ended without an answer (exit ${code}).`));
        }
        if (answer.rows) return resolve(answer.rows);
        reject(Object.assign(new Error(answer.error!.message), answer.error));
      }));
    if (timeout !== undefined && Number.isFinite(timeout) && timeout > 0) {
      timer = setTimeout(() =>
        settle(() => {
          child.kill("SIGKILL");
          reject(failure("timeout", `The statement ran past its timeout (${timeout} ms).`));
        }), timeout);
    }
    child.stdin.end(JSON.stringify({ path, sql, params, bytes: bytes ?? null }, plain));
  });
}
