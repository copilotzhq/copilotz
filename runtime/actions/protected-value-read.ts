/** Owner-private read authority for one policy's exact revocable query facade. */
import type { SqlExecutor } from "../events/session.ts";

type Scope = Readonly<{ databaseSchema: string; namespace: string }>;
type Binding = Scope & { check(): Promise<void> };
const reads = new WeakMap<SqlExecutor, Binding>();

export async function withProtectedValueRead<T>(
  transaction: SqlExecutor,
  scope: Scope,
  signal: AbortSignal,
  assertCurrent: () => void | Promise<void>,
  run: () => Promise<T>,
): Promise<T> {
  if (reads.has(transaction)) {
    throw new Error("Protected read authority is already bound.");
  }
  let active = true;
  const binding: Binding = {
    databaseSchema: scope.databaseSchema,
    namespace: scope.namespace,
    async check() {
      signal.throwIfAborted();
      if (!active) throw new Error("Protected read authority is closed.");
      await assertCurrent();
      signal.throwIfAborted();
      if (!active) throw new Error("Protected read authority is closed.");
    },
  };
  reads.set(transaction, binding);
  try {
    await binding.check();
    const result = await run();
    await binding.check();
    return result;
  } finally {
    active = false;
    reads.delete(transaction);
  }
}

/** Only the protected read path consumes this marker; it never grants commands. */
export function protectedValueReadCheck(
  transaction: SqlExecutor,
  scope: Scope,
): (() => Promise<void>) | undefined {
  const binding = reads.get(transaction);
  if (!binding) return undefined;
  if (
    binding.databaseSchema !== scope.databaseSchema ||
    binding.namespace !== scope.namespace
  ) throw new Error("Protected read authority belongs to another scope.");
  return () => binding.check();
}
