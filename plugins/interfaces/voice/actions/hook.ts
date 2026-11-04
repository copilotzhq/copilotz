/**
 * `voice.hook`: Twilio's webhook for a line the app declares, at
 * `/hooks/voice/<line>` (the web host's `routes` resource).
 *
 * - **A call comes in** (`POST /hooks/voice/<line>`): before anything else,
 *   Twilio's signature (`X-Twilio-Signature`) is checked with the line's auth
 *   token, and the call must be an inbound one to the line's account. Then
 *   it's taken only within the line's limits: calls at once (`atOnce`, 2)
 *   and in the last 24 hours (`perDay`, 50); else Twilio is told to reject
 *   it as busy (the caller hears a busy tone, and nothing is spent). A call
 *   taken is told to open the line's socket (TwiML `<Connect>` with
 *   `<ConversationRelay>`), with a ticket good for one use, for a minute;
 *   the greeting, language and voice are the line's. Twilio asking again
 *   for the same call gets a new ticket, and the old one stops working.
 * - **Its relay is over** (`POST /hooks/voice/<line>/over`, the `<Connect>`'s
 *   `action`): what Twilio says about it is noted on the call, which is
 *   over, and Twilio is told to hang up.
 *
 * Anyone may call it (it answers as a visitor); what isn't signed by the
 * line's account changes nothing. It isn't recorded: the ticket stays out
 * of the log.
 */
import { type Context, defineAction, type Infer } from "../../../../runtime/mod.ts";
import type { VoiceCall } from "../collections/call.ts";
import { HOOKS, type Line, lineOf } from "../shared/settings.ts";
import { signed } from "../shared/signature.ts";

/** A request as the web host hands it to a route's Action (hosts/web/routes.ts' `httpRequest`). */
const httpRequest = {
  type: "object",
  properties: {
    method: { type: "string" },
    path: { type: "string" },
    query: { type: "object", additionalProperties: { type: "string" } },
    headers: { type: "object", additionalProperties: { type: "string" } },
    body: { type: "string" },
    base64: { type: "boolean", const: true },
  },
  required: ["method", "path", "query", "headers"],
  additionalProperties: false,
} as const;

type HttpRequest = Infer<typeof httpRequest>;
type HttpAnswer = { status?: number; headers?: Record<string, string>; body?: string };

/** How long a socket's ticket works, once given. */
export const TICKET_MS = 60_000;

/** A call keeps its place among the calls at once this long past the line's longest call. */
export const SLACK_MS = 30_000;

const DAY = 86_400_000;

const plain = (status: number, body: string): HttpAnswer => ({ status, body });
const twiml = (body: string): HttpAnswer => ({
  headers: { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" },
  body: `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`,
});
const BUSY = twiml('<Reject reason="busy"/>');

/** Text as an XML attribute's value. */
const xml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");

export const hookAction = defineAction({
  description: "Twilio's webhook for a phone line the app declares",
  input: httpRequest,
  record: false,
  allow: () => true,
  run: async (ctx, request): Promise<HttpAnswer> => {
    const [name = "", what = "", ...more] = request.path.slice(HOOKS.length).split("/");
    const line = request.path.startsWith(HOOKS) && !more.length
      ? lineOf(ctx, decodeURIComponent(name))
      : undefined;
    if (!line || !["", "over"].includes(what)) return plain(404, "No such line");
    if (request.method !== "POST") return plain(405, "POST");
    if (!/^application\/x-www-form-urlencoded/i.test(request.headers["content-type"] ?? "")) {
      return plain(415, "A form");
    }
    const form = new URLSearchParams(request.body ?? "");
    // Twilio signs the URL it asked for: the line's public address, the path, the query as it came.
    const query = new URLSearchParams(request.query).toString();
    const url = `${new URL(line.origin).origin}${request.path}${query ? `?${query}` : ""}`;
    if (!await signed(line.token, request.headers["x-twilio-signature"], url, form)) {
      return plain(401, "Bad signature");
    }
    const call = form.get("CallSid") ?? "";
    if (form.get("AccountSid") !== line.account || !/^CA[0-9a-f]{32}$/i.test(call)) {
      return plain(403, "Not this line's call");
    }
    if (what === "over") return await over(ctx, call, form);
    if (form.get("Direction") !== "inbound") return plain(403, "Calls to the line only");
    return await taken(ctx, line, call, form);
  },
});

/**
 * A call coming in: taken within the line's limits, with a ticket for its
 * socket; else Twilio rejects it as busy.
 */
async function taken(ctx: Context, line: Line, id: string, form: URLSearchParams) {
  const secret = randomText(24);
  const ticket = `${id}.${secret}`;
  const hash = await sha256(secret);
  const now = Date.now();
  const at = new Date(now).toISOString();
  const until = new Date(now + TICKET_MS).toISOString();
  const system = ctx.as();
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
    const atOnce = recent.filter((c) => c.state !== "over" && Date.parse(c.until) > now).length;
    if (recent.length >= line.limits.perDay || atOnce >= line.limits.atOnce) return false;
    const from = form.get("From") ?? "";
    await calls.insertOne({
      _id: id,
      line: line.name,
      in: line.in,
      ...(from ? { from } : {}),
      to: form.get("To") ?? "",
      state: "ringing",
      ticket: hash,
      until,
      at,
    });
    return true;
  });
  if (!took) return BUSY;
  const relay = new URL(line.urls.relay);
  relay.searchParams.set("ticket", ticket);
  const attributes: Record<string, string | undefined> = {
    url: relay.toString(),
    language: line.language,
    welcomeGreeting: line.texts.greeting || undefined,
    ttsProvider: line.tts,
    voice: line.voice,
    transcriptionProvider: line.stt,
    dtmfDetection: line.keys ? "true" : undefined,
  };
  const said = Object.entries(attributes).filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}="${xml(value!)}"`).join(" ");
  return twiml(
    `<Connect action="${xml(line.urls.over)}"><ConversationRelay ${said}/></Connect>`,
  );
}

/** A call's relay is over, as Twilio says: noted on the call, which ends; Twilio hangs up. */
async function over(ctx: Context, id: string, form: URLSearchParams) {
  const calls = ctx.as().db.collection<VoiceCall>("voice_call");
  const found = await calls.findOne({ _id: id });
  if (found) {
    const status = form.get("SessionStatus") ?? form.get("CallStatus") ?? "";
    const error = form.get("ErrorCode") ?? "";
    let reason = "hangup";
    try {
      const handed = JSON.parse(form.get("HandoffData") ?? "{}") as { reason?: unknown };
      if (typeof handed?.reason === "string") reason = handed.reason.slice(0, 20);
    } catch {
      // Not ours: it was over all the same.
    }
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
  return twiml("<Hangup/>");
}

/** `n` random bytes, as URL-safe text. */
const randomText = (n: number) =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n))))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** SHA-256 of a text, in hex. */
export const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
