/** What chat is configured with and works in: agents, tools, turns, steps, frames, prompts. */
import type {
  Context,
  Infer,
  JSONSchema,
  Resources,
  ViewContext,
} from "../../../../runtime/mod.ts";
import type { Effort, LlmMessage, LlmTool, ModelRef, ToolCall } from "../../../models/contract.ts";
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
  /** Where one people made belongs (a space). */
  in?: string;
};

export type Tool<I = Record<string, unknown>> = {
  description: string;
  input?: JSONSchema;
  run(input: I, ctx: ToolContext): unknown;
  /**
   * Offered to every agent (`true`), to these, or where this says so (say,
   * once a thread is summarized), without being listed in their `tools`.
   */
  offer?: Offer;
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
};

/** A tool whose `run` input type comes from its JSON Schema. */
export const tool = <const S extends JSONSchema>(
  def: {
    description: string;
    input?: S;
    run(input: Infer<S>, ctx: ToolContext): unknown;
    offer?: Offer;
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

/** A tool call in an agent's step, with what it returned. */
export type Step = ToolCall & { output: string; sent?: string };

/**
 * A `conversation` resource: a View that a conversation shows on the web,
 * over where you type, with hints `{ thread, in, working }` (the thread, its
 * space, and whether an agent's turn is running there): something to
 * answer there, such as an agent waiting on your OK. `working` is true while
 * any turn step is live in the thread or its subthreads, and stays true
 * 600 ms after the last one ends (a turn's steps come about 50 ms apart),
 * so a View that waits for the turn to be over shows once, when it is.
 * Lowest `order` first; a View with nothing to show returns null.
 */
export type ConversationView = { view: string; order?: number };

/**
 * A `home` resource: a View home shows on the web, over its greeting, with
 * hints `{ in }` (where the person works): something for them now, such as
 * invitations to join a space. Lowest `order` first; a View with nothing to
 * show returns null.
 */
export type HomeView = { view: string; order?: number };

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
 * A `toolViews` resource: by a tool's name, the View kind that shows a call
 * to it in a conversation, in place of chat's own (what it was given and
 * what it returned, as data, folded). The View gets the call (`ShownCall`)
 * and hints `{ thread }`, and `running: true` while it hasn't returned.
 */
export type ToolViews = Record<string, string | null>;

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
export type Turn = { thread: string; agent: string; trigger: string; hops: number };

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
 * every agent unless `agents` says.
 */
export type ContextEntry = { place: "system" | "turn"; agents?: string[] };

/** Chat's settings, as configured. */
export const settingsOf = (ctx: { resources: Resources }): ChatSettings =>
  (ctx.resources.chat ?? {}) as ChatSettings;
