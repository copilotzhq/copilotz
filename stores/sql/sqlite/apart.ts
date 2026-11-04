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
 * The process is the runtime itself, never the app: only when the
 * executable is `deno`, `node` or `bun` (a compiled app runs as itself),
 * and on Deno only with permission to run it already granted (it never
 * asks). It gets no more than it needs: an environment of its own (no
 * `NODE_OPTIONS`, nothing of the app's), and on Deno and Node permission to
 * read the database's files alone. Where it can't start, the read says
 * `unstarted` (and why), and the store reads on its own connection instead.
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
type Spawn = (
  command: string,
  args: string[],
  options: { stdio: string[]; env: Record<string, string> },
) => Child;

/** The read, in the child: reads its request from stdin, answers on stdout. Rows past `bytes` aren't sent. */
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
  let cut = false;
  for (const row of db.prepare(sql).all(...params)) {
    const text = JSON.stringify({ ...row }, plain);
    used += new TextEncoder().encode(text).length + 1;
    if (bytes !== null && used > bytes) {
      cut = true;
      break;
    }
    rows.push(text);
  }
  process.stdout.write('{"cut":' + cut + ',"rows":[' + rows.join(",") + "]}");
} catch (error) {
  process.stdout.write(JSON.stringify({
    error: { message: String(error?.message ?? error), errcode: error?.errcode ?? error?.errno },
  }));
} finally {
  try { db?.close(); } catch {}
}
`;

const SOURCE = `data:text/javascript;base64,${btoa(CODE)}`;

/** The runtimes a read's process may be: the executable's name, without `.exe`. */
const RUNTIMES = new Set(["deno", "node", "bun"]);

/**
 * How this runtime runs the read, reading `files` alone where it can say
 * so: Deno and Node grant it read access to them and nothing else.
 */
const running = (runtime: string, files: string[]) =>
  runtime === "deno"
    ? ["run", "--quiet", "--no-prompt", "--no-config", `--allow-read=${files.join(",")}`, SOURCE]
    : runtime === "bun"
    ? ["-e", CODE]
    : [
      "--no-warnings",
      "--permission",
      ...files.map((file) => `--allow-fs-read=${file}`),
      "--input-type=module",
      "-e",
      CODE,
    ];

/** A process that couldn't start here: then no read runs apart, and `why` says so. */
const unstarted = (why: string, cause?: unknown) =>
  Object.assign(new Error(`The read's process didn't start: ${why}.`), {
    code: "unstarted",
    why,
    cause,
  });

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

type Here = {
  spawn: Spawn;
  execPath: string;
  /** An environment of its own: nothing of the app's (only Windows' own root, there). */
  env: Record<string, string>;
  runtime?: string;
  why?: string;
};

let started: Promise<Here | undefined> | undefined;

/** Whether, and how, this process can start the read's: why not, else the runtime it starts. */
async function look(): Promise<Here | undefined> {
  const [children, process] = await Promise.all([import(CHILDREN), import(PROCESS)]).catch(
    () => [undefined, undefined],
  );
  if (!children || !process) return undefined;
  const proc = process.default ?? process;
  const execPath = String(proc.execPath);
  const runtime = execPath.split(/[\\/]/).pop()!.replace(/\.exe$/i, "").toLowerCase();
  // Deno asks for a permission it lacks, mid-request: only one granted already is used.
  const deno = (globalThis as {
    Deno?: {
      permissions?: {
        querySync?(d: { name: string; command?: string; variable?: string }): { state: string };
      };
    };
  }).Deno;
  const granted = (d: { name: string; command?: string; variable?: string }) =>
    (deno?.permissions?.querySync?.(d).state ?? "granted") === "granted";
  const env: Record<string, string> = {};
  if (proc.platform === "win32" && granted({ name: "env", variable: "SystemRoot" })) {
    const root = proc.env.SystemRoot ?? proc.env.SYSTEMROOT;
    if (root) env.SystemRoot = root;
  }
  const here: Here = { spawn: children.spawn as Spawn, execPath, env, runtime };
  if (!RUNTIMES.has(runtime)) {
    return { ...here, why: `this program (${runtime}) isn't deno, node or bun, so not itself` };
  }
  if (!granted({ name: "run", command: execPath })) {
    return { ...here, why: "deno has no permission to run itself (--allow-run)" };
  }
  return here;
}

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
): Promise<Record<string, unknown>[] & { cut?: true }> {
  const here = await (started ??= look());
  if (!here) throw unstarted("this runtime starts no processes");
  if (here.why) throw unstarted(here.why);
  let child: Child;
  try {
    child = here.spawn(
      here.execPath,
      running(here.runtime!, [path, `${path}-wal`, `${path}-shm`]),
      {
        stdio: ["pipe", "pipe", "ignore"],
        env: here.env,
      },
    );
  } catch (error) {
    throw unstarted("it couldn't be started", error);
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
    child.on("error", (error) => settle(() => reject(unstarted("it couldn't be started", error))));
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
        let answer: {
          rows?: Record<string, unknown>[];
          cut?: boolean;
          error?: { message: string };
        };
        try {
          answer = JSON.parse(text, revive);
        } catch {
          return reject(new Error(`The read's process ended without an answer (exit ${code}).`));
        }
        if (answer.rows) {
          return resolve(
            answer.cut ? Object.assign(answer.rows, { cut: true as const }) : answer.rows,
          );
        }
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
