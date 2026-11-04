/**
 * A maintenance read of a SQLite file, apart: in a worker thread, on a
 * read-only connection of its own, closed after. SQLite runs a statement
 * synchronously, so on the store's own connection a long one would hold the
 * whole process; here the process goes on, the read answers its timeout,
 * and nothing the statement set (a pragma, a temporary object) outlives it.
 *
 * At the timeout the worker is stopped. Deno stops it at once; Node can't
 * stop SQLite in the middle of a statement, so there it runs on in its
 * thread until the statement ends (the process still answers everything
 * else, and its exit waits for that thread).
 */
import { failure } from "../../../runtime/errors.ts";

/** Not literal, so no bundler resolves it where there are no threads. */
const THREADS = "node:worker_threads";

type Thread = {
  once(event: "message", listener: (message: Answer) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "exit", listener: (code: number) => void): void;
  unref(): void;
  terminate(): Promise<number>;
};
type Threads = { Worker: new (url: URL, options: { workerData: unknown }) => Thread };
type Answer = { rows: Record<string, unknown>[] } | {
  error: { message: string; errcode?: number };
};

/** The worker: opens the file read-only (Bun's SQLite, else `node:sqlite`), runs, answers. */
const CODE = `
import { parentPort, workerData } from "node:worker_threads";
const { path, sql, params } = workerData;
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
  const rows = db.prepare(sql).all(...params).map((row) => ({ ...row }));
  parentPort.postMessage({ rows });
} catch (error) {
  parentPort.postMessage({
    error: { message: String(error?.message ?? error), errcode: error?.errcode ?? error?.errno },
  });
} finally {
  try { db?.close(); } catch {}
}
`;
const SOURCE = new URL(`data:text/javascript,${encodeURIComponent(CODE)}`);

let threads: Promise<Threads | undefined> | undefined;

/** Whether reads can run apart here: a runtime with worker threads. */
export const apart = (): Promise<boolean> =>
  (threads ??= import(THREADS).then((m) => m as Threads, () => undefined)).then(Boolean);

/** A worker that couldn't run here (no such module, a runtime's worker that won't load it). */
const unstarted = (cause: unknown) =>
  Object.assign(new Error("The read's worker didn't start."), { code: "unstarted", cause });

/**
 * Runs `sql` on `path`, read-only, in a worker; rejects with what SQLite
 * said (`errcode`), `timeout` after `timeout` ms, or `unstarted` when no
 * worker could run it (then reading apart doesn't work here).
 */
export async function readApart(
  path: string,
  sql: string,
  params: unknown[],
  timeout?: number,
): Promise<Record<string, unknown>[]> {
  const threads_ = await (threads ??= import(THREADS).then((m) => m as Threads, () => undefined));
  if (!threads_) throw unstarted(undefined);
  let worker: Thread;
  try {
    worker = new threads_.Worker(SOURCE, { workerData: { path, sql, params } });
  } catch (error) {
    throw unstarted(error);
  }
  return await new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const end = () => {
      settled = true;
      clearTimeout(timer);
      worker.unref();
      void worker.terminate().catch(() => {});
    };
    worker.once("message", (answer) => {
      if (settled) return;
      end();
      if ("rows" in answer) return resolve(answer.rows);
      reject(Object.assign(new Error(answer.error.message), { errcode: answer.error.errcode }));
    });
    // The worker answers every statement, its errors too: an error here is the worker's own.
    worker.once("error", (error) => {
      if (settled) return;
      end();
      reject(unstarted(error));
    });
    worker.once("exit", () => {
      if (settled) return;
      end();
      reject(unstarted(undefined));
    });
    if (timeout !== undefined && Number.isFinite(timeout) && timeout > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        end();
        reject(failure("timeout", `The statement ran past its timeout (${timeout} ms).`));
      }, timeout);
    }
  });
}
