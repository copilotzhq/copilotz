/** Private owner-bound authority, independent of logical command identity. */
import { createAsyncContextStorage } from "../../dependencies/async-hooks.ts";
import type { CommandContext } from "./commands.ts";
export type OwnerCommandAuthorization = (
  context: CommandContext,
  purpose: "mutation" | "result",
) => void | Promise<void>;
type Authority = {
  readonly guards: readonly OwnerCommandAuthorization[];
  readonly checks: readonly (() => void)[];
};
type Scope = Authority & {
  active: boolean;
  readonly authorizing?: boolean;
  captured?: OwnerCommandAuthorization;
};
const scopes = createAsyncContextStorage<Scope | undefined>();
const captured = new WeakMap<OwnerCommandAuthorization, Authority>();
function closed(): never {
  throw Object.assign(new Error("Action capability lifetime has ended."), {
    code: "ActionOwnershipLost",
  });
}
export async function withOwnerCommandAuthorization<T>(
  guard: OwnerCommandAuthorization,
  run: () => T | Promise<T>,
): Promise<T> {
  const parent = scopes.getStore();
  if (parent && !parent.active) closed();
  if (parent?.authorizing) {
    throw new Error("Owner authorization cannot submit commands.");
  }
  const inherited = captured.get(guard);
  const scope: Scope = {
    guards: [
      ...new Set([
        ...(parent?.guards ?? []),
        ...(inherited?.guards ?? [guard]),
      ]),
    ],
    checks: [...(parent?.checks ?? []), ...(inherited?.checks ?? [])],
    active: true,
  };
  try {
    return await scopes.run(scope, run);
  } finally {
    scope.active = false;
  }
}
/** Trusted policy callbacks cannot recursively admit public owner commands. */
export function withOwnerAuthorizationPhase<T>(
  run: () => T | Promise<T>,
): Promise<T> {
  return scopes.run(
    { guards: [], checks: [], active: true, authorizing: true },
    run,
  );
}
async function invoke(
  guard: OwnerCommandAuthorization,
  context: CommandContext,
  purpose: "mutation" | "result",
) {
  await withOwnerAuthorizationPhase(() => guard(context, purpose));
}
/** Called at command invocation, never at repository construction. */
export function captureOwnerCommandAuthorization():
  | OwnerCommandAuthorization
  | undefined {
  const scope = scopes.getStore();
  if (!scope) return;
  if (!scope.active) closed();
  if (scope.authorizing) {
    throw new Error("Owner authorization cannot submit commands.");
  }
  if (!scope.captured) {
    const authority = {
      guards: scope.guards,
      checks: [...scope.checks, () => {
        if (!scope.active) closed();
      }],
    };
    scope.captured = async (context, purpose) => {
      authority.checks.forEach((check) => check());
      for (const guard of authority.guards) {
        await invoke(guard, context, purpose);
      }
    };
    captured.set(scope.captured, authority);
  }
  return scope.captured;
}
/** Post-commit publication is a separate lifetime, never an Action capability. */
export const withoutOwnerCommandAuthorization = <T>(
  run: () => T | Promise<T>,
): Promise<T> => scopes.run(undefined, run);
const checked = new WeakMap<object, Set<OwnerCommandAuthorization>>();
export async function authorizeOwnerCommand(
  guard: OwnerCommandAuthorization | undefined,
  context: CommandContext,
  purpose: "mutation" | "result",
): Promise<void> {
  let guards = checked.get(context.transaction);
  if (guard) {
    const authority = captured.get(guard) ?? { guards: [guard], checks: [] };
    // The capability call must be live at admission. Once joined, its immutable
    // policy belongs to this owner transaction through the outer result gate.
    // The call wrapper may finish before its transaction commits.
    authority.checks.forEach((check) => check());
    if (!guards) {
      guards = new Set();
      checked.set(context.transaction, guards);
    }
    for (const member of authority.guards) {
      if (!guards.has(member)) {
        await invoke(member, context, "mutation");
        guards.add(member);
      }
    }
  }
  // An unguarded outer command must still check guards contributed by joined work.
  if (purpose === "result") {
    for (const member of guards ?? []) {
      await invoke(member, context, "result");
    }
  }
}
