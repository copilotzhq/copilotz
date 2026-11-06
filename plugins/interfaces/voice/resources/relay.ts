/**
 * A line's socket: Twilio's ConversationRelay, at `/hooks/voice/<line>/relay`
 * (a `serve` route of the web host, which hands it the runtime and takes
 * the socket: `host.upgrade()`). Twilio turns speech into text and text
 * into speech; here, a call is a chat.
 *
 * **Opening it:** Twilio's signature of the socket's address (the one the
 * webhook gave, with its ticket) is checked with the line's auth token, then
 * the ticket is used (`voice.admit`): once, within a minute. Anything else
 * is refused before a socket opens.
 *
 * **The call** (`talk`), as Twilio's messages come:
 * - `setup`: it must be the call the ticket was for (its ids and numbers),
 *   within 5 seconds. The caller is then a contact, in their chat
 *   (`voice.start`), while Twilio says the greeting.
 * - `prompt` (what the caller said, once they've finished): it goes to the
 *   agent as theirs (`chat.send`, as the contact), at once, one after the
 *   other. Said while the agent's answer to what they said before is still
 *   being written, that turn is stopped first, and the next turn reads both:
 *   the caller has moved on, and only one turn of a call runs at a time.
 * - What the agent answers them is said (`text` tokens): as it writes it,
 *   word by word, when its turn offers no tools but those called beside an
 *   answer (`aside`, as `end_call` is); else once it's whole. A
 *   step's words before its tools are never said, nor anything while tools
 *   run: a caller hears what a web visitor reads (the `voice_call` View).
 *   Only the turns the caller's own words started are said: what's written
 *   in their chat for someone else (a staff member's question) isn't. An
 *   answer that failed says the line's `failed` text, never its error.
 * - `interrupt` (the caller spoke over it): what was being said stops
 *   there, and the agent is told what they heard (`voice.heard`).
 * - `dtmf` (with the line's `keys`): keys pressed, a pause or `#` ending
 *   them, go to the agent as theirs, as a tap (`keys:<digits>`).
 * - The line's limits: an answer that takes longer than `turn` is stopped,
 *   and the `failed` text said; one past `said` characters is cut there (and
 *   stopped); past `idle` seconds of silence, `call` seconds, or `turns`
 *   things the caller said, the `bye` text is said and the call ends.
 * - It ends with Twilio's `end` (its `handoffData` says why: `agent`, once
 *   the agent's goodbye is said (`end_call`); `idle`; `limit`; `turns`),
 *   after what's being said, waiting 15 seconds at most; or when the caller
 *   hangs up. A call that's still open at its hard end (`lastsMs`) closes
 *   then, so it never outlasts its place among the line's calls at once.
 *   The call is then over (`voice.over`), and its agent's turn is stopped,
 *   and so is any turn of it that starts in the moments after: nobody would
 *   hear it.
 *
 * Calls cost by the minute, so it waits on nothing it needn't: no quiet
 * window (Twilio already waits for the caller to finish), the chat made
 * while the greeting plays, words sent as they come.
 */
import type { Actor, Runtime } from "../../../../runtime/mod.ts";
import type { Admitted, Started } from "../actions/call.ts";
import type { Saying } from "../views/call.ts";
import { declaredOf, GOODBYE_MS, HOOKS, lastsMs, type VoiceNumber } from "../shared/settings.ts";
import { signed } from "../shared/signature.ts";

/** A route's socket, as far as a call uses it (the web host's `RouteSocket`). */
export type RelaySocket = {
  readonly readyState: number;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

/** What the web host hands a `serve` route, as far as this one uses it. */
export type RelayHost = {
  runtime: Pick<Runtime, "call" | "observe" | "describe">;
  upgrade?(options?: { protocol?: string }): { socket: RelaySocket; response: Response };
};

const plain = (status: number, text: string) =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/** Answers a request for a line's socket: the socket, or why not. */
export async function serveRelay(request: Request, host?: RelayHost): Promise<Response> {
  if (!host?.runtime || !host.upgrade) return plain(501, "This host doesn't take sockets");
  const url = new URL(request.url);
  const [name = "", what, ...more] = url.pathname.slice(HOOKS.length).split("/");
  let named = "";
  try {
    named = decodeURIComponent(name);
  } catch {
    // A malformed name names no line.
  }
  const line = what === "relay" && !more.length && named
    ? declaredOf({ resources: host.runtime.describe().resources }, named)
    : undefined;
  if (!line) return plain(404, "No such line");
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return plain(426, "A socket only");
  }
  // Signed as the webhook gave it (`wss://`); some of Twilio's say `https://` for the same.
  const where = `${new URL(line.origin).host}${url.pathname}${url.search}`;
  const signature = request.headers.get("x-twilio-signature");
  const scheme = new URL(line.urls.relay).protocol.slice(0, -1);
  const fine = await signed(line.token, signature, `${scheme}://${where}`) ||
    await signed(line.token, signature, `${scheme === "ws" ? "http" : "https"}://${where}`);
  if (!fine) return plain(401, "Bad signature");
  const call = await host.runtime.call<Admitted | null>("voice.admit", {
    line: line.name,
    ticket: (url.searchParams.get("ticket") ?? "").slice(0, 200),
  });
  if (!call) return plain(401, "That ticket was used, or is too old");
  let upgraded: ReturnType<NonNullable<RelayHost["upgrade"]>>;
  try {
    upgraded = host.upgrade();
  } catch {
    await host.runtime.call("voice.over", { call: call._id, reason: "setup" }).catch(() => {});
    return plain(400, "Not a socket");
  }
  talk(host.runtime, upgraded.socket, call, line);
  return upgraded.response;
}

/** A socket's state when it's open. */
const OPEN = 1;
/** How long Twilio has to say which call this is, once the socket opens. */
const SETUP_MS = 5_000;
/** A pause after keys pressed ends what they typed. */
const KEYS_MS = 1_500;
/** About how long a character takes to say: when to hang up after a goodbye. */
const MS_PER_CHAR = 65;
/** Once a call is over, a turn of it that starts this soon after is stopped as it shows. */
const DRAIN_MS = 5_000;
/** The largest message from Twilio it reads, and the longest prompt. */
const MAX_FRAME = 16 * 1024;
const MAX_PROMPT = 4_000;

/** Twilio's messages, as far as a call reads them. */
type Relayed = {
  type?: string;
  callSid?: string;
  accountSid?: string;
  sessionId?: string;
  from?: string;
  to?: string;
  direction?: string;
  voicePrompt?: string;
  last?: boolean;
  utteranceUntilInterrupt?: string;
  digit?: string;
  description?: string;
};

/** The words of what's being written that are whole: up to its last space. */
const whole = (text: string) => text.slice(0, text.search(/\s\S*$/) + 1 || 0);

/** What's left to say of `text`, once `sent` of it was said. */
function rest(sent: string, text: string): string {
  if (text.startsWith(sent)) return text.slice(sent.length);
  let i = 0;
  while (i < sent.length && sent[i] === text[i]) i++;
  return text.slice(i);
}

/** How long to wait before Twilio's `end`, for what's being said: 15 seconds at most. */
export const goodbyeWait = (playedBy: number, now: number) =>
  Math.min(GOODBYE_MS, Math.max(0, playedBy - now)) + 250;

/** A call, over its socket, from Twilio's `setup` to its end (see above). */
export function talk(
  runtime: RelayHost["runtime"],
  socket: RelaySocket,
  call: Admitted,
  line: VoiceNumber,
): void {
  const { texts, limits } = line;
  let started: Promise<Started> | undefined;
  let seeing: ReturnType<typeof runtime.observe<Saying>> | undefined;
  let over = false;
  /** Why it's ending, once it is: what's said after that isn't heard. */
  let ending: string | undefined;
  /** What the caller said, one after the other; how many things so far. */
  let asking = Promise.resolve();
  let asked = 0;
  /** The caller said something the agent hasn't answered yet: the latest thing, and when. */
  let waiting = false;
  let latest = { message: "", at: "" };
  /** The turns the caller's words started (`<message>:<agent>`): only theirs are said. */
  const theirs = new Set<string>();
  const ours = (turn: string | undefined) => !!turn && theirs.has(turn);
  /** The turn of theirs writing now, turns whose words aren't said any more, and how much each said. */
  let working: string | undefined;
  const muted = new Set<string>();
  /** Turns whose `waiting` phrase was said. */
  const filled = new Set<string>();
  const spoken = new Map<string, number>();
  /** What's being said as it's written: its turn, the words sent, and, once cut, what was heard. */
  let current: { turn: string; sent: string; cut?: string } | undefined;
  /** What went last, whole (what an interruption cuts, when nothing is being written). */
  let last: string | undefined;
  /** What was said already, by message. */
  const done = new Set<string>();
  /** When what was sent will be said, about. */
  let playedBy = 0;
  let keys = "";
  const timers = {
    setup: setTimeout(() => finish("setup"), SETUP_MS),
    call: setTimeout(() => hangUp("limit", true), limits.call * 1000),
    // Its hard end: whatever happens, the call is over by then.
    hard: setTimeout(() => finish("limit"), lastsMs(line)),
    idle: undefined as ReturnType<typeof setTimeout> | undefined,
    turn: undefined as ReturnType<typeof setTimeout> | undefined,
    keys: undefined as ReturnType<typeof setTimeout> | undefined,
    end: undefined as ReturnType<typeof setTimeout> | undefined,
  };

  const send = (message: Record<string, unknown>) => {
    if (socket.readyState !== OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      finish("error");
    }
  };
  /** Says words (`last`: the end of what's said for now). */
  const say = (token: string, end: boolean) => {
    send({ type: "text", token, last: end });
    playedBy = Math.max(playedBy, Date.now()) + token.length * MS_PER_CHAR;
  };
  /**
   * Says words of a turn, within the characters an answer may say (`said`):
   * past them, what fits (to its last whole word) ends it, and the rest of
   * that turn isn't said, nor written on.
   */
  const speak = (turn: string, token: string, end: boolean) => {
    const had = spoken.get(turn) ?? 0;
    if (had + token.length <= limits.said) {
      spoken.set(turn, had + token.length);
      return say(token, end);
    }
    const room = token.slice(0, Math.max(0, limits.said - had));
    const at = room.search(/\s\S*$/);
    say(at >= 0 ? room.slice(0, at + 1) : "", true);
    spoken.set(turn, limits.said);
    muted.add(turn);
    if (current?.turn === turn) current = undefined;
    if (working === turn) void stopTurns();
  };
  const idle = () => {
    clearTimeout(timers.idle);
    if (over || ending || waiting) return;
    const after = limits.idle * 1000 + Math.max(0, playedBy - Date.now());
    timers.idle = setTimeout(() => hangUp("idle", true), after);
  };
  /** Stops the agent's turn in the call's chat, if one runs. */
  const stopTurns = () =>
    started?.then((s) => runtime.call("chat.stop", { thread: s.thread, agent: s.agent }))
      .catch(() => {});

  /** Ends the call: says goodbye (`bye`), waits for what's being said, then Twilio's `end`. */
  function hangUp(reason: string, bye: boolean) {
    if (over || ending) return;
    ending = reason;
    for (const timer of [timers.idle, timers.turn, timers.keys]) clearTimeout(timer);
    if (current) muted.add(current.turn);
    current = undefined;
    if (waiting) void stopTurns();
    if (bye) say(texts.bye, true);
    timers.end = setTimeout(() => {
      send({ type: "end", handoffData: JSON.stringify({ reason }) });
      // Twilio closes the socket; if it doesn't, it's closed here.
      timers.end = setTimeout(() => finish(reason), 5_000);
    }, goodbyeWait(playedBy, Date.now()));
  }

  /** The call is over: nothing more happens, and the call says why. */
  function finish(reason: string) {
    if (over) return;
    over = true;
    for (const timer of Object.values(timers)) clearTimeout(timer);
    // Nobody will hear what's still being worked on; nor a turn of the call that starts after.
    void stopTurns();
    setTimeout(() => seeing?.close(), DRAIN_MS);
    void runtime.call("voice.over", { call: call._id, reason: ending ?? reason }).catch(() => {});
    try {
      socket.close(1000, "over");
    } catch {
      // Closed already.
    }
  }

  /** What the caller says goes to the agent, as theirs, one thing after the other. */
  const ask = (text: string, tap?: { id: string; title: string }) =>
    asking = asking.then(() => told(text, tap));

  async function told(text: string, tap?: { id: string; title: string }) {
    let on: Started;
    try {
      on = await started!;
    } catch {
      return;
    }
    if (over || ending) return;
    if (asked >= limits.turns) return hangUp("turns", true);
    // They spoke again before the answer: that turn stops, and the next one reads both.
    if (waiting) await stopTurns();
    if (over || ending) return;
    const id = `voice:${call._id}:${++asked}`;
    waiting = true;
    clearTimeout(timers.idle);
    // They spoke: what was being said is cut, or was said.
    playedBy = Date.now();
    clearTimeout(timers.turn);
    timers.turn = setTimeout(tooLong, limits.turn * 1000);
    const contact: Actor = { kind: "contact", id: on.contact };
    latest = { message: "", at: new Date().toISOString() };
    try {
      const { message } = await runtime.call<{ message: string }>("chat.send", {
        thread: on.thread,
        text,
        ...(tap ? { tap } : {}),
      }, { actor: contact, id });
      theirs.add(`${message}:${on.agent}`);
      latest.message = message;
      saying();
    } catch (error) {
      console.error(`voice: what a caller said couldn't go on:`, (error as Error).message);
      clearTimeout(timers.turn);
      waiting = false;
      say(texts.failed, true);
      idle();
    }
  }

  /** No answer in the line's `turn` seconds: it's stopped, and the caller told so. */
  function tooLong() {
    if (!waiting || over || ending) return;
    waiting = false;
    if (working) muted.add(working);
    current = undefined;
    void stopTurns();
    say(texts.failed, true);
    idle();
  }

  /** What the agents said, and are writing: what's new of the caller's turns is said. */
  function saying() {
    const now = seeing?.get();
    if (now?.status !== "ready") return;
    const { said, live, end } = now.value;
    if (over) {
      // A turn of the call that started after it ended: stopped as it shows.
      if (ours(live?.turn)) void stopTurns();
      return;
    }
    for (const item of said) {
      if (done.has(item._id)) continue;
      // Someone else's turn in their chat isn't theirs to hear (not marked: it may yet be theirs,
      // once `chat.send` says which message started it).
      if (item.turn && !ours(item.turn)) continue;
      done.add(item._id);
      // What was being said as it was written is this, now whole.
      const mine = current && current.turn === item.turn ? current : undefined;
      if (mine) current = undefined;
      // Answered: what they said last, or after it (a stopped turn's answer is the one before's).
      if (item.replyTo === latest.message || (!item.stopped && item.at >= latest.at)) {
        waiting = false;
        clearTimeout(timers.turn);
      }
      if (mine?.cut !== undefined) {
        void runtime.call("voice.heard", { call: call._id, message: item._id, heard: mine.cut })
          .catch(() => {});
      } else if (!ending && !item.stopped && !(item.turn && muted.has(item.turn))) {
        const left = rest(mine?.sent ?? "", item.failed ? texts.failed : item.text);
        if (item.turn) {
          if (left || mine?.sent) speak(item.turn, left, true);
        } else if (left) say(left, true);
        last = item._id;
      }
      if (end && end.after === item.replyTo) hangUp(end.reason, false);
      idle();
    }
    working = ours(live?.turn) ? live!.turn : undefined;
    if (live && working && !ending && !muted.has(live.turn)) {
      if (current?.turn !== live.turn) current = { turn: live.turn, sent: "" };
      const ready = whole(live.text);
      if (current.cut === undefined && ready.length > current.sent.length) {
        const left = rest(current.sent, ready);
        current.sent = ready;
        if (left) speak(live.turn, left, false);
      }
    }
    // Tools run before any answer: the line's `waiting` phrase fills the silence, once per turn.
    if (
      line.waiting && live?.tools && working === live.turn && !ending && !muted.has(live.turn) &&
      !spoken.has(live.turn) && !filled.has(live.turn)
    ) {
      filled.add(live.turn);
      say(line.waiting, false);
    }
    if (end && !end.after && !waiting) hangUp(end.reason, false);
  }

  /** The caller spoke over what was being said: it stops there, and the agent is told. */
  function interrupted(heard: string) {
    playedBy = Date.now();
    if (current?.sent && current.cut === undefined) {
      current.cut = heard;
      // What's said for now ends there.
      say("", true);
      return;
    }
    if (last) {
      void runtime.call("voice.heard", { call: call._id, message: last, heard }).catch(() => {});
      last = undefined;
    }
  }

  /** A key pressed: keys go together, until a pause or `#`. */
  function pressed(digit: string) {
    if (!/^[0-9*#]$/.test(digit)) return;
    clearTimeout(timers.keys);
    if (digit !== "#") keys += digit;
    const typed = () => {
      const all = keys;
      keys = "";
      if (all) void ask(all, { id: `keys:${all}`, title: all });
    };
    if (digit === "#" || keys.length >= 32) typed();
    else timers.keys = setTimeout(typed, KEYS_MS);
  }

  /** Twilio says which call this is: the one the ticket was for, or the socket closes. */
  function setup(m: Relayed) {
    if (started) return;
    clearTimeout(timers.setup);
    if (
      m.callSid !== call._id || m.accountSid !== line.account ||
      (m.from ?? "") !== (call.from ?? "") || m.to !== call.to ||
      (m.direction !== undefined && m.direction !== "inbound")
    ) return finish("setup");
    started = runtime.call<Started>("voice.start", {
      call: call._id,
      ...(typeof m.sessionId === "string" ? { session: m.sessionId.slice(0, 100) } : {}),
    });
    started.then((on) => {
      if (over) return;
      const contact: Actor = { kind: "contact", id: on.contact };
      // Twilio says the greeting itself.
      if (on.greeting) done.add(on.greeting);
      const { thread, since } = on;
      // Read as the line's agent working for the caller: only what both may read, and of that,
      // what a contact would (answers, not steps), the View keeps to.
      seeing = runtime.observe<Saying>("voice_call", {
        _id: call._id,
        thread,
        contact: on.contact,
        since,
      }, {
        actor: { kind: "agent", id: on.agent, for: contact },
        viewer: { kind: "contact", name: `contact:${on.contact}` },
      });
      seeing.subscribe(saying);
      saying();
      idle();
    }, (error) => {
      console.error("voice: a call couldn't start:", (error as Error).message);
      say(texts.failed, true);
      hangUp("error", false);
    });
  }

  socket.onmessage = (event) => {
    if (over) return;
    // As early as the socket lets it: a frame too large, or not text, is let go unread.
    const data = event?.data;
    if (typeof data !== "string" || data.length > MAX_FRAME) return;
    let m: Relayed;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    if (m.type === "setup") return setup(m);
    // Nothing counts before Twilio says which call this is.
    if (!started) return;
    if (m.type === "prompt") {
      const text = typeof m.voicePrompt === "string" ? m.voicePrompt.trim() : "";
      if (m.last !== false && text) void ask(text.slice(0, MAX_PROMPT));
    } else if (m.type === "interrupt") {
      interrupted(typeof m.utteranceUntilInterrupt === "string" ? m.utteranceUntilInterrupt : "");
    } else if (m.type === "dtmf" && line.keys) {
      pressed(String(m.digit ?? ""));
    } else if (m.type === "error") {
      console.error("voice: Twilio says:", String(m.description ?? "").slice(0, 300));
    }
  };
  socket.onclose = () => finish("hangup");
  socket.onerror = () => finish("error");
}
