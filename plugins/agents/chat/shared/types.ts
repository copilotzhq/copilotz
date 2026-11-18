/** What chat is configured with and works in: agents, tools, turns, steps, frames, prompts. */
import type {
  Context,
  Infer,
  JSONSchema,
  Resources,
  ViewContext,
} from "../../../../runtime/mod.ts";
import type { Effort, LlmMessage, LlmTool, ModelRef, ToolCall } from "../../../models/contract.ts";
import type { IconName } from "../../../../hosts/web/mod.ts";
import type { Thread } from "../collections/thread.ts";

export type Agent = {
  instructions: string;
  /** `"provider/model"`, an alias from `resources.model`, or a list tried in order. */
  model: ModelRef;
  /** How hard it thinks, for a reasoning model; the catalog checks the model takes it. */
  effort?: Effort;
  maxTokens?: number;
  temperature?: number;
  /** Names of `tools` resources it may call, and `send_message` to talk to others. */
  tools?: string[];
  /** The skills it may read (the skills plugin's), by name; all of them when not said. */
  skills?: string[];
  /** What it does, for other agents deciding whom to message. */
  description?: string;
  /**
   * Joins new conversations; with the access plugin, joins new spaces (the
   * first answering their new chats). When no agent does, the first declared does.
   */
  default?: boolean;
  /** What it's shown as, when not its name (one people made: "Maya", called `maya`). */
  name?: string;
  /** An emoji it's shown with. */
  icon?: string;
  /** Where one people made belongs: a space, or the org itself (`*`, one of the org's own). */
  in?: string;
  /**
   * One of the app's agents whose model it takes where the app chooses its
   * agents' models (the `agentModel` resource: the tier's, as that agent's),
   * keeping `model` where nothing chooses: one an org made that works like
   * one of the app's.
   */
  like?: string;
  /**
   * How much of a conversation it's sent. `maxAge` (ms): what's older, back
   * from the newest message it sees, stays out of its prompt (summaries of
   * it too), and in the chat. The start moves in steps of a tenth of it
   * (`ageStart`), so the prompt only grows between steps.
   */
  history?: { maxAge?: number };
};

export type Tool<I = Record<string, unknown>> = {
  description: string;
  input?: JSONSchema;
  run(input: I, ctx: ToolContext): unknown;
  /**
   * Offered to every agent (`true`), to these, or where this says so (say,
   * once a thread is summarized), without being listed in their `tools`. A
   * function decides for agents that list it too: where it says no (working
   * for a contact, say), it isn't offered.
   */
  offer?: Offer;
  /** What people see it called ("Search trips"), where they're shown it: its name otherwise. */
  title?: string;
  /** What it does to the world, for whoever decides how to call it (see `ToolAnnotations`). */
  annotations?: ToolAnnotations;
  /**
   * Called beside an answer, never for what it tells the model (hanging up a
   * call once the answer is said): a turn offered no tools but these is all
   * answers, so a contact reads (and a caller hears) its words as they're
   * written (`live.open`), as with no tools at all.
   */
  aside?: boolean;
};

/**
 * What a tool does to the world, as hints for whoever calls it: a model
 * outside (MCP's annotations), or an app asking before a destructive one.
 * Hints, not rules: what it may do is still what its caller may.
 *
 * - `readOnly`: it changes nothing (a search).
 * - `destructive`: it may change or remove what's there, not only add.
 * - `idempotent`: calling it again with the same input changes nothing more.
 * - `openWorld`: it reaches outside the app (another company's system, the web).
 */
export type ToolAnnotations = {
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  openWorld?: boolean;
};

/** Whom a tool is offered to: everyone, these agents, or decided per agent and thread. */
export type Offer =
  | true
  | string[]
  | ((agent: string, thread: Thread, ctx: ViewContext) => boolean);

/** What a tool's code reaches: the runtime, and whose turn it runs in. */
/** A message's `via` when it's handed from one space to another, either way. */
export const DELEGATED = "delegated";

export type ToolContext = Context & {
  /** The agent calling it, the thread it works in, and the message it answers. */
  agent: string;
  thread: string;
  trigger: string;
  /**
   * This call's id, the same however many times it runs: the idempotency key
   * for what it does outside (a payment, an email). A call returns once: a
   * retried turn reuses what it returned. One cut short (its executor lost,
   * the runtime closed) runs again as itself, with `retry` true, and the
   * recorded Actions it called answer from the log; `retry` is false when the
   * call never ran before.
   */
  callId: string;
  /**
   * In an agent's turn: a question this call can't go on without (a person's
   * yes), to `to`. It's written with the call's step, as the agent's message
   * to them, and the turn waits for its reply as it does for the messages it
   * sends, other questions and messages of the step too. Then the call runs
   * again, as itself, in a step of its own after the answer, with `answer`;
   * what it returns then is what the agent reads. It returns the question's
   * id: what an answer replies to (`chat.send`'s `replyTo`). Asked again in
   * the same call, it's the same question. Absent where no turn waits (a
   * model outside, over MCP): there, a tool says in its output what it waits
   * for.
   */
  ask?: (question: { to: string; text: string }) => string;
  /** On a call run again once its question was answered: who answered, and what they said. */
  answer?: { from: string; text: string };
};

/** A tool whose `run` input type comes from its JSON Schema. */
export const tool = <const S extends JSONSchema>(
  def: {
    description: string;
    input?: S;
    run(input: Infer<S>, ctx: ToolContext): unknown;
    offer?: Offer;
    title?: string;
    annotations?: ToolAnnotations;
    aside?: boolean;
  },
): Tool => def as Tool;

/** Chat's settings: the `chat` resource, which an app patches (`resources: { chat: { maxHops: 3 } }`). */
export type ChatSettings = {
  /**
   * How many agent messages in a row, after a person's, may start another
   * agent's turn. Replies still resume agents waiting for them. Off by default.
   */
  maxHops?: number;
  /**
   * How many steps (model calls) one agent turn may take before it fails,
   * so a runaway agent stops. Off by default: a turn goes on until it
   * answers, waits, or someone stops it (`chat.stop`).
   */
  maxSteps?: number;
  /**
   * The model that transcribes audio sent with a message (default: the
   * `transcribe` alias, from `resources.model`).
   */
  transcriber?: ModelRef;
};

/**
 * A tool call in an agent's step, with what it returned: the message it sent
 * (`send_message`'s), or the question it asked and waited on (`ToolContext.ask`).
 */
export type Step = ToolCall & { output: string; sent?: string; asked?: string };

/**
 * A `conversation` resource: what a front end adds where a conversation is
 * typed in, on the web (its page, and a chat's staff notes beside it): a
 * View, a hook before sending, or both. Lowest `order` first.
 *
 * Its `view` shows over where you type, with hints `{ thread, in, side,
 * working, busy }` (the thread, its space, its side threads, whether an
 * agent's turn is running there, and whose): something to answer there, such
 * as an agent waiting on your OK, here or in a side thread. `busy` lists the
 * agents with a turn step live in the thread or its subthreads, each kept
 * 600 ms after its last one ends (a turn's steps come about 50 ms apart), and
 * `working` is whether there are any; so a View that waits for an agent's
 * turn to be over shows once, when it is, whoever else works on. A View with
 * nothing to show returns null.
 *
 * Its `beforeSend` is asked as the person sends from that box (Enter, or the
 * send button), before anything goes, with what's sent (`Sending`) and how
 * the page calls Actions, as the person: to act first (take the conversation
 * over) or to check it. It may take its time; the box says it's sending
 * meanwhile. `false` holds the message: nothing goes, what's typed stays, and
 * the front end says why itself (its View). Thrown, nothing goes either, and
 * its words show over the box, as a refused send's do. Hooks run one after
 * another; the first to hold or throw stops the rest. A function: a front
 * end's resource, in the page's plugins.
 *
 * ```ts
 * conversation: {
 *   desk: { view: "desk.bar", order: 5, beforeSend: ({ thread }, call) => call("desk.take", { thread }) },
 * }
 * ```
 */
export type ConversationView = {
  view?: string;
  order?: number;
  beforeSend?(
    sending: Sending,
    call: ViewContext["call"],
  ): boolean | void | Promise<boolean | void>;
};

/**
 * What a `conversation` entry's `beforeSend` is given as the person sends:
 * the conversation (a chat's notes are one too) and its space, the words
 * (trimmed; empty for files alone), and the files going with them, a voice
 * message among them, by name and media type.
 */
export type Sending = {
  thread: string;
  in?: string;
  text: string;
  files: { name: string; type: string }[];
};

/**
 * A `home` resource: a View home shows on the web, over its greeting, with
 * hints `{ in }` (where the person works): something for them now, such as
 * invitations to join a space. Lowest `order` first; a View with nothing to
 * show returns null.
 */
export type HomeView = { view: string; order?: number };

/**
 * A `welcome` resource: a step of the app's welcome, which home shows each
 * person once in a dialog, the first time they come to it (and again at
 * `/?welcome=1`): its title and a line under it, and a View (hints `{ in }`)
 * for what it says or asks. Lowest `order` first. `roles`: only those in the
 * org with one of them see it (`owner`, `admin`, `member`, `guest`; staff
 * see every step), as for the org's settings. `orgs`: only in orgs of those
 * kinds (`personal`, `team`), where the app serves many.
 */
export type WelcomeStep = {
  title: string;
  description?: string;
  view: string;
  order?: number;
  roles?: string[];
  orgs?: string[];
};

/**
 * A `refusals` resource: by a code `chat.send` can refuse a message with
 * (`not_here`), the View shown over where you type in its place, the
 * message kept there: what to do about it. Its hints: `{ thread?, in,
 * names, text, message, resend, dismiss }`: the chat (none from home), its
 * space, the names the message mentioned that don't answer there, what was
 * typed, the refusal's words, and two functions: `resend()` sends it again,
 * as it is, and `dismiss()` puts the View away. Without one for a code, the
 * refusal shows as an error.
 */
export type RefusalView = { view: string };

/**
 * A `composerNotes` resource: by key, a View shown over the box where you
 * type, in a conversation and on home, with hints `{ thread?, in?, working }`
 * (the chat, none from home; its space; whether agents are at work): what to
 * know before sending. Lowest `order` first; a View with nothing to say
 * returns null, and takes no room.
 */
export type ComposerNote = { view: string; order?: number };

/**
 * A `composerControls` resource: a View beside the send button, on home and
 * in a conversation, with hints `{ thread?, in? }` (none from home): a small
 * control for how what's sent goes (the tier it runs on). Lowest `order`
 * first; one with nothing to offer returns null.
 */
export type ComposerControl = { view: string; order?: number };

/**
 * A `toolViews` resource: by a tool's name, the View kind that shows a call
 * to it in a conversation, in place of chat's own (what it was given and
 * what it returned, as data, folded). The View gets the call (`ShownCall`)
 * and hints `{ thread }`, and `running: true` while it hasn't returned.
 */
export type ToolViews = Record<string, string | null>;

/**
 * An `askViews` resource entry: by a kind of ask (an approval's `work`), the
 * View that says what's asked on its card in a conversation, and the icon
 * beside it, in place of chat's own words (a computer's command, as a
 * command). The View gets the approval and hints `{ agent, aside }`: the
 * agent as it's named, and whether it was asked in a side thread. Chat draws
 * the card around it and its answers: only those the ask takes.
 */
export type AskView = { view: string; icon?: IconName };

/** A tool call, as a `toolViews` View gets it: no `output` while it runs. */
export type ShownCall = {
  /** The call's id. */
  _id: string;
  name: string;
  input?: Record<string, unknown>;
  /** What it returned, as the agent read it (JSON, or words). */
  output?: string;
};

/** What starts or resumes an agent's turn. */
/**
 * A turn: its thread, its agent, the message it answers and how many agent
 * messages in a row led to it. Resumed from a wait whose step asked
 * questions, `step` is that step's message: its asked calls run again first.
 */
export type Turn = { thread: string; agent: string; trigger: string; hops: number; step?: string };

/**
 * What an agent is sent: its tools, then the zones the prompt cache wants
 * (stable, then growing, then new).
 */
export type Prompt = { tools: LlmTool[]; system: string[]; history: LlmMessage[]; turn: Told[] };

/**
 * A `turn` context an agent was told: its name and its text. Kept on the
 * first message its turn writes, so later turns are sent it where it was, and
 * the conversation only grows (the prompt cache keeps all of it).
 */
export type Told = { name: string; text: string };

/**
 * A `context` resource: where text a plugin or app adds to agents' prompts
 * goes. The text is the `context:<name>` View of the thread. `system` text must
 * be stable (it is cached across turns); `turn` text comes after the
 * conversation when it says something new (when it's not what the agent was
 * last told there), and stays in the conversation where it came. It goes to
 * every agent unless `agents` says. Any other text is tagged as information,
 * not instructions; `instructions` is for the app's own words on how its
 * agents work (a charter): `system` text sent as they are, after the agent's
 * own instructions.
 */
export type ContextEntry = { place: "system" | "turn"; agents?: string[]; instructions?: boolean };

/**
 * An `additions` resource: what a feature shows after an agent's final
 * answer, in a place that can (WhatsApp: a carousel of trips after the
 * answer that found them). Its content is a View, `addition:<name>`, which
 * that place looks up, given `{ thread, answer }`: it returns an `Addition`, several, or
 * nothing. Lowest `order` first; only after the answers of `agents`, when it
 * names them.
 */
export type AdditionEntry = { order?: number; agents?: string[] };

/**
 * What an `addition:<name>` View returns: the parts to show (each in the
 * place's own terms), once per chat per `key` (at most 120 of `[\w:.-]`:
 * `trips:9f2a`), what goes instead when the place refuses a part
 * (`fallback`: the trips as a text list), and a line the model is told after
 * that answer (`note`: "6 trips as a carousel").
 */
export type Addition<Part = unknown> = {
  key: string;
  parts: Part[];
  fallback?: Part[];
  note?: string;
};

/** Chat's settings, as configured. */
export const settingsOf = (ctx: { resources: Resources }): ChatSettings =>
  (ctx.resources.chat ?? {}) as ChatSettings;
