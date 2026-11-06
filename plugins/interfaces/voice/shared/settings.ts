/**
 * The voice plugin's settings (the `voice` resource): the numbers the app
 * declares, by name, as a flat map. Each is a Twilio number whose calls this
 * app answers, with its space, its credentials, how it sounds and its limits.
 * `declaredOf` gives a number with every default filled in, as the plugin uses it.
 */
import type { Resources } from "../../../../runtime/mod.ts";

/** A number the app declares: a Twilio number open to anyone who calls. */
export type DeclaredVoiceNumber = {
  /** The space its callers' chats live in (declared with the spaces plugin's `spaces`, or not). */
  in: string;
  /** Twilio's account SID (`AC…`) and auth token: the token signs Twilio's requests. */
  account: string;
  token: string;
  /**
   * The app's public address, as Twilio reaches it (`https://calls.example.com`):
   * the signatures cover it, and the socket's address is made from it.
   */
  origin: string;
  /** Who answers its callers: an agent of its space (else who answers new chats there). */
  agent?: string;
  /** What callers speak and hear: a BCP-47 tag (`pt-BR`; `en-US` by default). */
  language?: string;
  /** Twilio's text-to-speech provider (`ElevenLabs`, `Google`, `Amazon`) and its voice. */
  tts?: string;
  voice?: string;
  /** Twilio's speech-to-text provider (`Deepgram`, `Google`). */
  stt?: string;
  /** Lines said to callers, instead of the language's own (see `TEXTS`); `greeting: ""` says none. */
  texts?: Partial<Texts>;
  /**
   * Said once when a turn starts running tools before any answer ("One moment, let me check"), so
   * a caller doesn't hear silence meanwhile. None by default; never said for an answer without tools.
   */
  waiting?: string;
  /**
   * Hours of quiet after which a caller's next call starts a new chat (`GAP`). Calling back goes
   * on in the same chat only when Twilio verified the number (STIR/SHAKEN), or with
   * `trustCallerId`: a number alone isn't proof of who's calling.
   */
  gap?: number;
  /** A caller's number is who they are, verified or not: their calls go on in one chat. */
  trustCallerId?: boolean;
  /** Keys pressed on the phone come to the agent too (Twilio's `dtmfDetection`). */
  keys?: boolean;
  /** How much calls may cost: see `Limits`. */
  limits?: Partial<Limits>;
  /** Days its calls' records are kept, once they're over (`KEEP`, 30; 1 at least). */
  keep?: number;
};

/**
 * What calls on a number may cost. Past them, a call isn't taken (Twilio rejects it as busy:
 * nothing is spent), or it ends politely.
 */
export type Limits = {
  /** Calls at once, and calls that went on in any 24 hours, on the number. */
  atOnce: number;
  perDay: number;
  /** The same, from one caller (by number), checked first. */
  callerAtOnce: number;
  callerPerDay: number;
  /**
   * The same, for all callers whose number is hidden, who can't be told apart: their own
   * allowance, instead of one caller's (by default the number's `atOnce`, and half its `perDay`).
   */
  hiddenAtOnce: number;
  hiddenPerDay: number;
  /** Seconds for an answer, of silence, and for a whole call. */
  turn: number;
  idle: number;
  call: number;
  /** Things the caller may say in a call, and characters an answer may say. */
  turns: number;
  said: number;
};

/**
 * 0.x's limits, kept (2 at once, 50 a day, 25 s an answer, 90 s of silence, 10 minutes, 30
 * things said a call), with a caller's own: 1 call at once, 10 a day; hidden numbers', together:
 * the number's at once, half its day (here 2 and 25); and 1,200 characters an answer (about 80
 * seconds said).
 */
export const LIMITS: Limits = {
  atOnce: 2,
  perDay: 50,
  callerAtOnce: 1,
  callerPerDay: 10,
  hiddenAtOnce: 2,
  hiddenPerDay: 25,
  turn: 25,
  idle: 90,
  call: 600,
  turns: 30,
  said: 1_200,
};

/** Days a call's record is kept (a number's `keep`), and a caller's link to their contact. */
export const KEEP = 30;

/** Hours a caller's chat stays the one they're in, as WhatsApp's (12): calling back goes on. */
export const GAP = 12;

/** What callers are told: the greeting, a turn that failed (never its error), and goodbye. */
export type Texts = { greeting: string; failed: string; bye: string };

/** The plugin's own texts, by a language's first part (`pt` of `pt-BR`); English for any other. */
export const TEXTS: Record<string, Texts> = {
  en: {
    greeting: "Hi! How can I help?",
    failed: "Sorry, I couldn't answer that. Could you say it again?",
    bye: "I'll end the call now. Goodbye!",
  },
  pt: {
    greeting: "Olá! Como posso ajudar?",
    failed: "Desculpe, não consegui responder agora. Pode repetir?",
    bye: "Vou encerrar a ligação agora. Até logo!",
  },
};

/** The `voice` resource: the declared numbers, by name. */
export type VoiceSettings = Record<string, DeclaredVoiceNumber>;

/** Where every number's paths start: `/hooks/voice/<name>`, `…/relay`, `…/over`. */
export const HOOKS = "/hooks/voice/";

/** The numbers the app declares, by name. */
export const numbersOf = (ctx: { resources: Resources }): VoiceSettings =>
  Object.fromEntries(
    Object.entries((ctx.resources.voice ?? {}) as VoiceSettings).filter(([, number]) => number),
  );

/** The longest a goodbye waits for what's being said, before Twilio's `end`; then closing. */
export const GOODBYE_MS = 15_000;
export const CLOSING_MS = 5_000;

/** The longest a call lasts, from its socket opening: its limit, its goodbye, and closing. */
export const lastsMs = (line: Pick<VoiceNumber, "limits">) =>
  line.limits.call * 1000 + GOODBYE_MS + CLOSING_MS;

/** A number as the plugin uses it: its settings, its name, and every default filled in. */
export type VoiceNumber = DeclaredVoiceNumber & {
  name: string;
  language: string;
  texts: Texts;
  limits: Limits;
  gap: number;
  keep: number;
  /** Where Twilio calls: the webhook, the socket and the end of a call's relay. */
  urls: { hook: string; relay: string; over: string };
};

/** The number `name`, ready to use; undefined when the app declares none by that name. */
export function declaredOf(ctx: { resources: Resources }, name: string): VoiceNumber | undefined {
  const numbers = numbersOf(ctx);
  const line = Object.hasOwn(numbers, name) ? numbers[name] : undefined;
  if (!line) return undefined;
  const language = line.language ?? "en-US";
  const own = TEXTS[language.split("-")[0].toLowerCase()] ?? TEXTS.en;
  const origin = new URL(line.origin);
  const hook = `${origin.origin}${HOOKS}${encodeURIComponent(name)}`;
  return {
    ...line,
    name,
    language,
    texts: { ...own, ...line.texts },
    limits: limitsOf(line.limits),
    gap: line.gap ?? GAP,
    keep: line.keep ?? KEEP,
    urls: {
      hook,
      relay: `${origin.protocol === "http:" ? "ws" : "wss"}://${origin.host}${
        new URL(hook).pathname
      }/relay`,
      over: `${hook}/over`,
    },
  };
}

/** A number's limits, the defaults filled in: hidden numbers' from the number's own. */
function limitsOf(given: Partial<Limits> = {}): Limits {
  const merged = { ...LIMITS, ...given };
  return {
    ...merged,
    hiddenAtOnce: given.hiddenAtOnce ?? merged.atOnce,
    hiddenPerDay: given.hiddenPerDay ?? Math.floor(merged.perDay / 2),
  };
}

/** What's wrong with a number's settings, if anything (checked when the app starts). */
export function problemOf(name: string, line: DeclaredVoiceNumber): string | undefined {
  for (const field of ["in", "account", "token", "origin"] as const) {
    if (typeof line?.[field] !== "string" || !line[field]) return `needs its ${field}`;
  }
  if (!/^[\w-]{1,60}$/.test(name)) return "its name is letters, digits, - and _";
  if (!/^AC[0-9a-f]{32}$/i.test(line.account)) return "its account is Twilio's account SID (AC…)";
  let origin: URL;
  try {
    origin = new URL(line.origin);
  } catch {
    return "its origin is a URL";
  }
  if (!/^https?:$/.test(origin.protocol) || origin.pathname !== "/" || origin.search) {
    return "its origin is the app's public address alone (https://…, no path)";
  }
  if (line.language !== undefined && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(line.language)) {
    return 'its language is a BCP-47 tag, such as "pt-BR"';
  }
  for (const [key, value] of Object.entries(line.limits ?? {})) {
    if (!(key in LIMITS)) return `limits.${key} isn't a limit`;
    if (typeof value !== "number" || !(value > 0)) return `limits.${key} is a number over 0`;
  }
  if (line.gap !== undefined && !(line.gap >= 0)) return "its gap is hours, 0 or more";
  if (line.keep !== undefined && !(typeof line.keep === "number" && line.keep >= 1)) {
    return "its keep is days, 1 or more";
  }
  return undefined;
}
