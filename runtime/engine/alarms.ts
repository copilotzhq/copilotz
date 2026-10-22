import {
  assertSchemaCommandTransaction,
  schemaCommandContext,
} from "./commands.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createCoreTableNames } from "../events/schema.ts";

// A command owns its dirty sources; rollback discards them with the context.
const dirty = new WeakMap<object, Set<string>>();
export function invalidateOwnerAlarm(
  transaction: SqlExecutor,
  schema: string,
  source = "",
): void {
  const context = schemaCommandContext(transaction, schema);
  let sources = dirty.get(context);
  if (!sources) dirty.set(context, sources = new Set());
  sources.add(source);
}

/** Durable work identity includes its namespace; opaque keys never use delimiters. */
export type OwnerDeadline = Readonly<{
  source: string;
  key: string;
  namespace: string | null;
  dueAt: string;
  payload: unknown;
  revision: string;
}>;

export type OwnerAlarmSource = Readonly<{
  name: string;
  /** Reads only inside the already fenced command; never calls another command. */
  nextDeadline?(transaction: SqlExecutor, now: string): Promise<string | null>;
  /** Work runs outside the command transaction and makes ordinary owner commands. */
  wake(deadlines: readonly OwnerDeadline[]): Promise<void>;
}>;

export type OwnerAlarmScheduler = Readonly<{
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}>;

export function reconciliationAlarmKey(
  owner: string,
  target: { kind: string; namespace: string | null; id: string },
): string {
  return JSON.stringify([
    "reconciliation",
    owner,
    target.kind,
    target.namespace,
    target.id,
  ]);
}

/** Called only with the active owner's transaction. Null removes a deadline. */
export async function writeOwnerDeadline(
  transaction: SqlExecutor,
  schema: string,
  input: Omit<OwnerDeadline, "dueAt" | "payload" | "revision"> & {
    dueAt: string | null;
    payload?: unknown;
  },
  owner = "schema",
): Promise<void> {
  assertSchemaCommandTransaction(transaction, schema);
  invalidateOwnerAlarm(transaction, schema);
  const table = createCoreTableNames(schema).owner_deadlines;
  if (input.dueAt === null) {
    await transaction.query(
      `DELETE FROM ${table} WHERE owner=$1 AND source=$2 AND key=$3`,
      [owner, input.source, input.key],
    );
    return;
  }
  const dueAt = new Date(input.dueAt).toISOString();
  await transaction.query(
    `INSERT INTO ${table} (owner,source,key,namespace,due_at,payload)
     VALUES ($1,$2,$3,$4,$5::timestamptz,$6::jsonb)
     ON CONFLICT (owner,source,key) DO UPDATE SET namespace=EXCLUDED.namespace,
       due_at=EXCLUDED.due_at,payload=EXCLUDED.payload,revision=EXCLUDED.revision`,
    [
      owner,
      input.source,
      input.key,
      input.namespace,
      dueAt,
      JSON.stringify(input.payload ?? null),
    ],
  );
}

/** Compare the selected deadline: completion must not erase a newly scheduled wake. */
export async function completeOwnerDeadline(
  transaction: SqlExecutor,
  schema: string,
  deadline: OwnerDeadline,
  owner = "schema",
): Promise<void> {
  await completeOwnerDeadlines(transaction, schema, [deadline], owner);
}

/** One wake consumes its selected revisions in one statement, without erasing re-arms. */
export async function completeOwnerDeadlines(
  transaction: SqlExecutor,
  schema: string,
  deadlines: readonly OwnerDeadline[],
  owner = "schema",
): Promise<void> {
  assertSchemaCommandTransaction(transaction, schema);
  if (!deadlines.length) return;
  invalidateOwnerAlarm(transaction, schema);
  await transaction.query(
    `DELETE FROM ${createCoreTableNames(schema).owner_deadlines} AS deadline
     USING unnest($2::text[],$3::text[],$4::bigint[]) AS selected(source,key,revision)
     WHERE deadline.owner=$1 AND deadline.source=selected.source
       AND deadline.key=selected.key AND deadline.revision=selected.revision`,
    [
      owner,
      deadlines.map((d) => d.source),
      deadlines.map((d) => d.key),
      deadlines.map((d) => d.revision),
    ],
  );
}

export function createOwnerAlarmDriver(options: {
  session: SqlSession;
  schema: string;
  owner: string;
  now(): Date;
  ready(): boolean;
  stopped(): boolean;
  fail(error: unknown): void;
  scheduler?: OwnerAlarmScheduler;
}) {
  const tables = createCoreTableNames(options.schema);
  const sources = new Map<string, OwnerAlarmSource[]>();
  const scheduler = options.scheduler ?? {
    schedule: (callback: () => void, delay: number) =>
      setTimeout(callback, delay),
    cancel: (handle: unknown) => clearTimeout(handle as number),
  };
  let timer: unknown;
  let dueAt: string | null | undefined;
  let generation = 0;
  let waking = false;
  let paused = false;
  let activeWake: Promise<void> | undefined;
  const tasks = new Set<Promise<void>>();
  function track(task: Promise<void>): Promise<void> {
    tasks.add(task);
    void task.finally(() => tasks.delete(task)).catch(() => undefined);
    return task;
  }
  function cancel() {
    generation++;
    const pending = timer;
    timer = undefined;
    if (pending !== undefined) scheduler.cancel(pending);
  }
  function rearm(): Promise<void> {
    return track((async () => {
      if (dueAt === undefined) {
        const result = await options.session.query<{ due_at: string | Date }>(
          `SELECT due_at FROM ${tables.owner_alarms} WHERE owner=$1`,
          [options.owner],
        );
        // A command may have committed while the activation read was pending.
        if (dueAt === undefined) {
          dueAt = result.rows[0]
            ? new Date(result.rows[0].due_at).toISOString()
            : null;
        }
      }
      arm();
    })());
  }
  function arm(): void {
    if (paused || !options.ready() || options.stopped() || waking) return;
    cancel();
    const current = generation;
    const due = dueAt;
    if (!due) return;
    // Long delays are re-armed against the persisted timestamp, never overflow.
    const delay = Math.min(
      2_147_483_647,
      Math.max(0, new Date(due).getTime() - options.now().getTime()),
    );
    timer = scheduler.schedule(() => {
      timer = undefined;
      if (current !== generation || options.stopped()) return;
      void wake().catch(options.fail);
    }, delay);
  }
  function wake(): Promise<void> {
    if (activeWake) return activeWake;
    const task = runWake();
    activeWake = task;
    void task.finally(() => {
      if (activeWake === task) activeWake = undefined;
    }).catch(() => undefined);
    return track(task);
  }
  async function runWake(): Promise<void> {
    if (paused || !options.ready() || options.stopped()) return;
    waking = true;
    try {
      const result = await options.session.query<{
        source: string;
        key: string;
        namespace: string | null;
        due_at: string | Date;
        payload: unknown;
        revision: string | number;
      }>(
        `SELECT source,key,namespace,due_at,payload,revision FROM ${tables.owner_deadlines}
         WHERE owner=$1 AND due_at <= $2::timestamptz ORDER BY due_at,source,key LIMIT 1000`,
        [options.owner, options.now().toISOString()],
      );
      const grouped = new Map<string, OwnerDeadline[]>();
      for (const row of result.rows) {
        const list = grouped.get(row.source) ?? [];
        list.push({
          source: row.source,
          key: row.key,
          namespace: row.namespace,
          dueAt: new Date(row.due_at).toISOString(),
          payload: row.payload,
          revision: String(row.revision),
        });
        grouped.set(row.source, list);
      }
      for (const [name, deadlines] of grouped) {
        if (options.stopped()) return;
        const source = sources.get(name)?.at(-1);
        if (!source) {
          throw new Error(`No owner alarm handler registered for '${name}'.`);
        }
        await source.wake(deadlines);
      }
    } finally {
      waking = false;
    }
    await rearm();
  }
  return {
    register(source: OwnerAlarmSource): () => void {
      const registrations = sources.get(source.name) ?? [];
      registrations.push(source);
      sources.set(source.name, registrations);
      return () => {
        const index = registrations.indexOf(source);
        if (index >= 0) registrations.splice(index, 1);
        if (!registrations.length) sources.delete(source.name);
      };
    },
    async refresh(
      transaction: SqlExecutor,
      now: string,
    ): Promise<string | null | undefined> {
      const changed = dirty.get(
        schemaCommandContext(transaction, options.schema),
      );
      if (!changed) return undefined;
      for (const name of changed) {
        const source = sources.get(name)?.at(-1);
        if (source?.nextDeadline) {
          await writeOwnerDeadline(transaction, options.schema, {
            source: name,
            key: "source",
            namespace: null,
            dueAt: await source.nextDeadline(transaction, now),
          }, options.owner);
        }
      }
      const result = await transaction.query<{ due_at: string | Date | null }>(
        `WITH next AS (SELECT MIN(due_at) AS due_at FROM ${tables.owner_deadlines} WHERE owner=$1),
         removed AS (DELETE FROM ${tables.owner_alarms} WHERE owner=$1 AND (SELECT due_at FROM next) IS NULL),
         saved AS (INSERT INTO ${tables.owner_alarms} (owner,name,due_at)
           SELECT $1,'wake',due_at FROM next WHERE due_at IS NOT NULL
           ON CONFLICT (owner) DO UPDATE SET due_at=EXCLUDED.due_at)
         SELECT due_at FROM next`,
        [options.owner],
      );
      return result.rows[0]?.due_at
        ? new Date(result.rows[0].due_at).toISOString()
        : null;
    },
    committed(next: string | null | undefined) {
      if (next === undefined || next === dueAt) return;
      dueAt = next;
      arm();
    },
    rearm,
    wake,
    cancel,
    pause() {
      paused = true;
      cancel();
    },
    async drain() {
      // Drain the work admitted before this attachment began closing. A shared
      // owner may keep admitting work for surviving attachments; including those
      // later tasks would make one attachment's shutdown unbounded. A selected
      // wake already awaits its own final rearm, so its descendants stay covered.
      await Promise.allSettled([...tasks]);
    },
  };
}
