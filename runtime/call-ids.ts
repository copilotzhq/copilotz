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

/** A call's canonical `[action, input]`: what its hash and its count are of, worked out once. */
export const callText = (action: string, input: unknown): string =>
  canonical([action, input ?? null]);

/**
 * A quick 53-bit hash (cyrb53), in base 36: a small key for a call's count. Two inputs
 * that met on one would share a count, numbered by their order between them, as rc.64
 * numbered every call; at 53 bits, with the text's length beside it, they don't.
 */
const short = (text: string): string => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}.${text.length}`;
};

/** What a Processor's delivery names its calls and timers under: apart from other Processors'. */
export const deliveryCaller = (event: string, processor: string): string => `${event}:${processor}`;

/** What a caller's identical calls are counted under: the caller and the call's text (`callText`). */
export const sameCall = (caller: string, text: string): string => `${caller}\u0000${short(text)}`;

/** A nested call's id: its caller, its Action, its number among identical calls, its input's hash. */
export const callId = (caller: string, action: string, n: number, inputHash: string): string =>
  `${caller}.${action}#${n}.${inputHash}`;
