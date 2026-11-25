/**
 * Nested calls' ids. A recorded call that code makes is kept under an id
 * naming its caller, the Action, its input, and how many calls of that Action
 * with that input the caller made before it: `<caller>.<action>#<n>.<inputHash>`.
 * No other call moves it: one refused or allowed, added, or started in another
 * order on a retry leaves every completed call where a retry finds it.
 *
 * The caller is the call's own id, `<event>:<processor>` for a Processor's
 * delivery, and `<caller>/<key>` in a branch (`ctx.branch`).
 */
import { canonical } from "./registry.ts";

/** What a Processor's delivery names its calls and timers under: apart from other Processors'. */
export const deliveryCaller = (event: string, processor: string): string => `${event}:${processor}`;

/** What a caller's identical calls are counted under: the caller, the Action and its input. */
export const sameCall = (caller: string, action: string, input: unknown): string =>
  `${caller}\u0000${canonical([action, input ?? null])}`;

/** A nested call's id: its caller, its Action, its number among identical calls, its input's hash. */
export const callId = (caller: string, action: string, n: number, inputHash: string): string =>
  `${caller}.${action}#${n}.${inputHash}`;
