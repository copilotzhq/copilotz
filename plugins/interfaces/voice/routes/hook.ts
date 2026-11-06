/**
 * Twilio's webhook for a line the app declares: `POST /hooks/voice/<line>`
 * (a call comes in) and `POST /hooks/voice/<line>/over` (its relay is over).
 *
 * Before anything else, Twilio's signature (`X-Twilio-Signature`) is checked
 * with the line's auth token, and the call must be one of the line's
 * account's (an inbound one, for a call coming in). Then the work is the
 * plugin's, as plain data (`voice.ring`, `voice.hangup`; see
 * actions/ring.ts), and what Twilio is told is TwiML:
 *
 * - **A call taken** is told to open the line's socket (`<Connect>` with
 *   `<ConversationRelay>`), with the ticket the action gave; the greeting,
 *   language and voice are the line's. Not taken, it is told to reject the
 *   call as busy.
 * - **Its relay is over:** Twilio is told to hang up.
 *
 * Anyone may call it; what isn't signed by the line's account changes
 * nothing.
 */
import { bodyOf, type Route } from "../../../../runtime/mod.ts";
import { lineOf } from "../shared/settings.ts";
import { signed } from "../shared/signature.ts";

/** The largest form it reads: Twilio's are a few KiB. */
const MOST = 64 * 1024;

const plain = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
const twiml = (body: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    headers: { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" },
  });
const BUSY = '<Reject reason="busy"/>';

/** Text as an XML attribute's value. */
const xml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");

/** A path's part, decoded; a malformed one names nothing. */
const decoded = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return "";
  }
};

export const hookRoute: Route = async (request, { runtime, params }) => {
  const line = lineOf({ resources: runtime.describe().resources }, decoded(params.name ?? ""));
  const url = new URL(request.url);
  const over = url.pathname.endsWith("/over");
  if (!line) return plain(404, "No such line");
  if (request.method !== "POST") return plain(405, "POST", { allow: "POST" });
  if (!/^application\/x-www-form-urlencoded/i.test(request.headers.get("content-type") ?? "")) {
    return plain(415, "A form");
  }
  const bytes = await bodyOf(request, MOST);
  if (!bytes) return plain(413, "Too large");
  const form = new URLSearchParams(new TextDecoder().decode(bytes));
  // Twilio signs the URL it asked for: the line's public address, the path, the query as it came.
  const where = `${new URL(line.origin).origin}${url.pathname}${url.search}`;
  if (!await signed(line.token, request.headers.get("x-twilio-signature"), where, form)) {
    return plain(401, "Bad signature");
  }
  const call = form.get("CallSid") ?? "";
  if (form.get("AccountSid") !== line.account || !/^CA[0-9a-f]{32}$/i.test(call)) {
    return plain(403, "Not this line's call");
  }
  if (over) {
    let reason: string | undefined;
    try {
      const handed = JSON.parse(form.get("HandoffData") ?? "{}") as { reason?: unknown };
      if (typeof handed?.reason === "string") reason = handed.reason;
    } catch {
      // Not ours: it was over all the same.
    }
    const status = form.get("SessionStatus") ?? form.get("CallStatus") ?? "";
    const error = form.get("ErrorCode") ?? "";
    await runtime.call("voice.hangup", {
      call,
      ...(status ? { status } : {}),
      ...(error ? { error } : {}),
      ...(reason ? { reason } : {}),
    });
    return twiml("<Hangup/>");
  }
  if (form.get("Direction") !== "inbound") return plain(403, "Calls to the line only");
  const taken = await runtime.call<{ ticket: string } | null>("voice.ring", {
    line: line.name,
    call,
    from: form.get("From") ?? "",
    to: form.get("To") ?? "",
    ...(form.get("StirVerstat") ? { verstat: form.get("StirVerstat")! } : {}),
  });
  if (!taken) return twiml(BUSY);
  const relay = new URL(line.urls.relay);
  relay.searchParams.set("ticket", taken.ticket);
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
  return twiml(`<Connect action="${xml(line.urls.over)}"><ConversationRelay ${said}/></Connect>`);
};
