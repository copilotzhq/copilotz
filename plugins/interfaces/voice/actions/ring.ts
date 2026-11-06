/**
 * What Twilio's webhook (`routes/hook.ts`) asks of the plugin, as plain data;
 * only trusted code calls them (no `allow`), and neither is recorded: the
 * ticket stays out of the log. The route has checked Twilio's signature and
 * that the call is the line's account's.
 *
 * - `voice.ring`: **a call comes in.** A caller the line's people blocked
 *   (`voice.block`) isn't taken. Then it's taken only within its caller's
 *   limits (`callerAtOnce`, 1; `callerPerDay`, 10; hidden numbers, together,
 *   their own: `hiddenAtOnce`, `hiddenPerDay`), then the line's (`atOnce`, 2;
 *   `perDay`, 50 calls that went on in the last 24 hours); else null: Twilio
 *   is told to reject it as busy (a busy tone, and nothing is spent). Whether
 *   Twilio verified the number (`StirVerstat`) is noted on the call. A call
 *   taken gets a ticket for the line's socket, good for one use, for a
 *   minute. Twilio asking again for the same call gets a new ticket, and the
 *   old one stops working.
 * - `voice.hangup`: **its relay is over** (the `<Connect>`'s `action`): what
 *   Twilio says about it is noted on the call, which is over.
 */
import { type Context, defineAction } from "../../../../runtime/mod.ts";
import type { VoiceCall } from "../collections/call.ts";
import type { VoiceBlock } from "../collections/blocked.ts";
import { type Line, lineOf } from "../shared/settings.ts";
import { blockedKey, callerKey, VERIFIED } from "../shared/caller.ts";

/** How long a socket's ticket works, once given. */
export const TICKET_MS = 60_000;

const DAY = 86_400_000;

export const ringAction = defineAction({
  description: "A call comes in on a line: taken, with a ticket for its socket, or not",
  input: {
    type: "object",
    properties: {
      line: { type: "string" },
      call: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      /** Twilio's `StirVerstat`, if it sent one. */
      verstat: { type: "string" },
    },
    required: ["line", "call"],
    additionalProperties: false,
  },
  record: false,
  run: async (ctx, input): Promise<{ ticket: string } | null> => {
    const line = lineOf(ctx, input.line);
    if (!line) return null;
    return await taken(ctx, line, input.call, input);
  },
});

export const hangupAction = defineAction({
  description: "A call's relay is over, as Twilio says",
  input: {
    type: "object",
    properties: {
      call: { type: "string" },
      status: { type: "string" },
      error: { type: "string" },
      reason: { type: "string" },
    },
    required: ["call"],
    additionalProperties: false,
  },
  record: false,
  run: async (ctx, input) => await over(ctx, input.call, input),
});

/** Whether a caller is blocked on a line now (a block past its `until` is over). */
async function blockedNow(ctx: Context, line: string, from: string, now: number) {
  const block = await ctx.as().db.collection<VoiceBlock>("voice_blocked")
    .findOne({ key: await blockedKey(line, from) });
  return !!block && (!block.until || Date.parse(block.until) > now);
}

/**
 * A call coming in: taken unless its caller is blocked, and within its
 * caller's limits and then the line's, with a ticket for its socket; else
 * Twilio rejects it as busy. A day's calls are those that went on (a call
 * never answered costs nothing); calls at once, those holding a place.
 */
async function taken(
  ctx: Context,
  line: Line,
  id: string,
  call: { from?: string; to?: string; verstat?: string },
): Promise<{ ticket: string } | null> {
  const secret = randomText(24);
  const ticket = `${id}.${secret}`;
  const hash = await sha256(secret);
  const now = Date.now();
  const at = new Date(now).toISOString();
  const until = new Date(now + TICKET_MS).toISOString();
  const from = call.from ?? "";
  const caller = callerKey(from);
  const system = ctx.as();
  if (await blockedNow(ctx, line.name, from, now)) return null;
  // One transaction: the owner writes one at a time, so two calls can't both take the last place.
  const took = await system.transaction(async (tx) => {
    const calls = tx.db.collection<VoiceCall>("voice_call");
    const recent = await calls.find({
      line: line.name,
      at: { $gt: new Date(now - DAY).toISOString() },
    });
    const again = recent.find((c) => c._id === id);
    if (again) {
      // Twilio asking again (its request timed out): a new ticket, while the call isn't on yet.
      if (again.state !== "ringing") return false;
      await calls.updateOne({ _id: id }, { $set: { ticket: hash, until } });
      return true;
    }
    const holding = (c: VoiceCall) => c.state !== "over" && Date.parse(c.until) > now;
    const theirs = recent.filter((c) => callerKey(c.from) === caller);
    const { limits } = line;
    // Hidden numbers, together, have an allowance of their own: one caller's would lock them all out.
    const hidden = caller === "hidden";
    if (
      theirs.filter(holding).length >= (hidden ? limits.hiddenAtOnce : limits.callerAtOnce) ||
      theirs.filter((c) => c.started).length >=
        (hidden ? limits.hiddenPerDay : limits.callerPerDay) ||
      recent.filter(holding).length >= limits.atOnce ||
      recent.filter((c) => c.started).length >= limits.perDay
    ) return false;
    await calls.insertOne({
      _id: id,
      line: line.name,
      in: line.in,
      ...(from ? { from } : {}),
      to: call.to ?? "",
      ...(call.verstat === VERIFIED ? { verified: true } : {}),
      state: "ringing",
      ticket: hash,
      until,
      at,
    });
    return true;
  });
  return took ? { ticket } : null;
}

/** A call's relay is over, as Twilio says: noted on the call, which ends. */
async function over(
  ctx: Context,
  id: string,
  said: { status?: string; error?: string; reason?: string },
) {
  const calls = ctx.as().db.collection<VoiceCall>("voice_call");
  const found = await calls.findOne({ _id: id });
  if (found) {
    const status = said.status ?? "";
    const error = said.error ?? "";
    const reason = said.reason?.slice(0, 20) || "hangup";
    const twilio = {
      ...(status ? { status: status.slice(0, 40) } : {}),
      ...(error ? { error: error.slice(0, 40) } : {}),
    };
    const now = new Date();
    await calls.updateOne({ _id: id }, {
      $set: {
        ...(Object.keys(twilio).length ? { twilio } : {}),
        ...(found.state === "over" ? {} : {
          state: "over",
          over: now.toISOString(),
          reason: status === "failed" ? "error" : reason,
          ...(found.started
            ? { seconds: Math.round((now.getTime() - Date.parse(found.started)) / 1000) }
            : {}),
        }),
      },
      $unset: { ticket: "" },
    });
  }
}

/** `n` random bytes, as URL-safe text. */
const randomText = (n: number) =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n))))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** SHA-256 of a text, in hex. */
export const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
