/**
 * The `engine` model adapter: a model call run on a plan's CLI on the
 * computer of the person it's for (see shared/engines.ts), through
 * `computer.engine`, which it asks as them (`connection.call`). Which CLI is
 * its provider's `options.engine`.
 *
 * The CLI keeps a session of its own on that computer. A step of a turn
 * goes on in it: the CLI asks for one of the agent's tools, the step ends
 * with that call (while the CLI waits), and the next step sends the result
 * back and goes on streaming the same answer. What says where it is goes in
 * the answer's state (`EngineState`), which comes back with the next call,
 * so nothing is kept here.
 *
 * A session is a cache: the conversation's own history is the truth. The
 * next turn goes on in the same session only when what it was given then is
 * still what the conversation says (its hash): edited, summarized, or with
 * other instructions or tools, a fresh session is given the whole history.
 * A step tried again (its stream broke) reattaches to the same answer, from
 * where the step began.
 */
import type {
  LlmAdapter,
  LlmChunk,
  LlmMessage,
  LlmRequest,
  LlmTool,
  ToolCall,
} from "../../../models/contract.ts";
import type { EngineEvent } from "../actions/engine.ts";
import { engineFailure, type EngineName } from "../shared/engines.ts";

/** Where a session's answer is, carried in each step's state. */
export type EngineState = {
  computer: string;
  session: string;
  /** How many of the conversation's messages the session was given, and their hash. */
  given: number;
  hash: string;
  /** The answer under way, while its tool calls wait: its id, and the next event to read. */
  prompt?: string;
  from?: number;
  calls?: string[];
};

/** What a step asks `computer.engine` for, beside the engine, model, instructions and tools. */
type Ask = {
  computer?: string;
  session?: string;
  id: string;
  from?: number;
  results?: { id: string; content: string }[];
  prompt: unknown[];
};

/**
 * A step's ask, and what the session will have been given (`given` messages,
 * their `hash`); `left`: an answer the conversation went on without (its
 * turn stopped, or waiting), to stop first.
 */
type Plan = { ask: Ask; given: number; hash: string; left?: { computer: string; session: string } };

/**
 * A prompt's id: the same for a step tried again (the same turn, the same
 * conversation, what it's given, the same plan and model), and no other
 * conversation's. A turn's next plan or model is another prompt: the
 * computer keeps its prompts by id, for every plan, and would hand the next
 * one the first's answer (its failure).
 */
const idOf = async (request: LlmRequest, of: string) =>
  (await sha256(
    [
      request.tags?.thread ?? "",
      request.tags?.turn ?? "",
      request.options?.engine ?? "",
      request.connection.model,
      of,
    ].join(":"),
  )).slice(0, 32);

const encoder = new TextEncoder();

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A message as the session read it: what it says, never its state or cache marks. */
const plain = (message: LlmMessage) =>
  message.role === "user"
    ? { role: "user", text: message.text, files: message.files?.map((f) => f.name) }
    : message.role === "assistant"
    ? {
      role: "assistant",
      text: message.text ?? "",
      calls: message.toolCalls?.map((c) => [c.id, c.name, c.input]),
    }
    : { role: "tool", id: message.toolCallId, text: message.text };

/** What a session was given: the instructions, the tools and the first `given` messages. */
const hashOf = (instructions: string, tools: LlmTool[], messages: LlmMessage[]) =>
  sha256(JSON.stringify([instructions, tools, messages.map(plain)]));

/** A user message's own words, and the files it came with by name. */
const words = (message: Extract<LlmMessage, { role: "user" }>) =>
  message.files?.length
    ? `${message.text}\n(files: ${message.files.map((f) => f.name).join(", ")})`
    : message.text;

/** A message, as text for a session told the history it doesn't have. */
function rendered(message: LlmMessage): string {
  if (message.role === "user") return `[user]\n${words(message)}`;
  if (message.role === "tool") return `[result of ${message.toolCallId}]\n${message.text}`;
  const calls = (message.toolCalls ?? []).map((c) =>
    `[you called ${c.name} (${c.id}) with ${JSON.stringify(c.input)}]`
  );
  return [`[you]\n${message.text ?? ""}`, ...calls].join("\n");
}

/** New messages, as the session takes them: a person's in their own words. */
const blocks = (messages: LlmMessage[]) =>
  messages.map((m) => ({ type: "text", text: m.role === "user" ? words(m) : rendered(m) }));

/** The input for a session: the newest messages, or (`history`) all, earlier ones told as such. */
function input(messages: LlmMessage[], history: boolean): unknown[] {
  if (!history) return blocks(messages);
  const lastUser = messages.findLastIndex((m) => m.role === "user");
  const before = lastUser > 0 ? messages.slice(0, lastUser) : [];
  const now = lastUser >= 0 ? messages.slice(lastUser) : messages;
  return [
    ...(before.length
      ? [{
        type: "text",
        text: `The conversation so far, for context:\n\n${before.map(rendered).join("\n\n")}`,
      }]
      : []),
    ...blocks(now),
    ...(now.at(-1)?.role === "user" ? [] : [{ type: "text", text: "Continue." }]),
  ];
}

const toolsFor = (tools: LlmTool[]) =>
  tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input }));

/** What to ask the computer for this step, and what the session will have been given. */
async function planOf(request: LlmRequest): Promise<Plan> {
  const { instructions = "", messages, tools = [] } = request;
  const at = messages.findLastIndex((m) => m.role === "assistant" && m.state);
  const state = at >= 0
    ? (messages[at] as Extract<LlmMessage, { role: "assistant" }>).state!.data as EngineState
    : undefined;
  const after = at >= 0 ? messages.slice(at + 1) : [];
  if (state) {
    // Its tool calls answered, and nothing else since: the same answer goes on.
    const answers = after.filter((m): m is Extract<LlmMessage, { role: "tool" }> =>
      m.role === "tool"
    );
    if (
      state.prompt && state.calls?.length && answers.length === after.length &&
      state.calls.every((id) => answers.some((m) => m.toolCallId === id))
    ) {
      return {
        ask: {
          computer: state.computer,
          session: state.session,
          id: state.prompt,
          from: state.from ?? 0,
          results: answers.map((m) => ({ id: m.toolCallId, content: m.text })),
          prompt: [],
        },
        given: state.given,
        hash: state.hash,
      };
    }
    // What it was given is still what the conversation says: it goes on with what's new.
    const same = !state.prompt &&
      state.hash === await hashOf(instructions, tools, messages.slice(0, state.given));
    if (same && after.length) {
      const given = messages.length;
      const hash = await hashOf(instructions, tools, messages);
      return {
        ask: {
          computer: state.computer,
          session: state.session,
          id: await idOf(request, `${state.session}:${hash}`),
          prompt: input(after, false),
        },
        given,
        hash,
      };
    }
  }
  const plan = await fresh(request, state?.computer);
  return state?.prompt
    ? { ...plan, left: { computer: state.computer, session: state.session } }
    : plan;
}

/** A session that starts afresh, given the whole history. */
async function fresh(request: LlmRequest, computer?: string): Promise<Plan> {
  const { instructions = "", messages, tools = [] } = request;
  const hash = await hashOf(instructions, tools, messages);
  return {
    ask: {
      ...(computer ? { computer } : {}),
      id: await idOf(request, `new:${hash}`),
      prompt: input(messages, true),
    },
    given: messages.length,
    hash,
  };
}

export const engineAdapter: LlmAdapter = {
  async *generate(request: LlmRequest): AsyncGenerator<LlmChunk> {
    const { connection, options = {}, instructions = "", tools = [], signal } = request;
    const engine = options.engine as EngineName | undefined;
    const call = connection.call;
    if (!engine) throw engineFailure("engine_missing", "This provider names no engine.");
    if (!call) {
      throw engineFailure("engine_missing", "This call isn't for anyone: no plan to run it on.");
    }
    let plan = await planOf(request);
    // The answer it left stops now, while this job can still ask (its CLI waits on nobody).
    if (plan.left) {
      await call("computer.engine.cancel", plan.left).catch(() => {});
    }
    for (let tries = 0;; tries++) {
      let computer = plan.ask.computer;
      let session = plan.ask.session;
      let next = plan.ask.from ?? 0;
      const calls: ToolCall[] = [];
      let wrote = false;
      let thought = 0;
      let waking = false;
      let stale: string | undefined;
      const events = await call<AsyncIterable<EngineEvent>>("computer.engine", {
        engine,
        model: connection.model,
        instructions,
        tools: toolsFor(tools),
        ...plan.ask,
      });
      try {
        for await (const event of events) {
          // Its computer is waking (one that sleeps): said, until it's awake and at work.
          if (event.type === "waking") {
            waking = true;
            yield event;
            continue;
          }
          if (event.type === "computer") {
            computer = event.computer;
            if (waking) yield { type: "thinking" };
            waking = false;
            continue;
          }
          next = event.i + 1;
          if (event.type === "session") session = event.session;
          else if (event.type === "update") {
            const update = event.update as {
              sessionUpdate?: string;
              content?: { type?: string; text?: string };
            };
            if (update.sessionUpdate === "agent_message_chunk" && update.content?.text) {
              wrote = true;
              yield { type: "text", text: update.content.text };
            } else if (
              update.sessionUpdate === "agent_thought_chunk" && Date.now() - thought > 1000
            ) {
              thought = Date.now();
              yield { type: "thinking" };
            }
          } else if (event.type === "call") {
            calls.push({
              id: event.call.id,
              name: event.call.name,
              input: (event.call.arguments ?? {}) as Record<string, unknown>,
            });
          } else if (event.type === "done") {
            // Refused with nothing said (a provider's policy): the next model, not an empty answer.
            if (event.stopReason === "refusal" && !wrote && !calls.length) {
              throw engineFailure("engine_refusal", "The plan's model declined to answer.");
            }
            if (event.usage) yield { type: "usage", ...event.usage };
          } else if (event.type === "failed") {
            // A session that can't go on (gone, given other tools, left busy elsewhere): once, afresh.
            if (
              (event.code === "stale" || event.code === "lost" || event.code === "busy") &&
              !wrote && !tries
            ) {
              stale = event.code;
              // On the log, so a plan that keeps starting over (its whole history again) shows.
              const where = request.tags?.thread ? ` [thread=${request.tags.thread}]` : "";
              console.warn(
                `computers: ${engine} session ${session ?? "(new)"} ${event.code} ` +
                  `(${event.message}): starting afresh${where}`,
              );
              break;
            }
            throw engineFailure(`engine_${event.code}`, event.message);
          }
        }
      } catch (error) {
        // Stopped (the turn was): the CLI stops too, when it's anywhere to stop.
        if (signal?.aborted && computer && session) {
          void call("computer.engine.cancel", { computer, session }).catch(() => {});
        }
        throw error;
      }
      if (stale) {
        plan = await fresh(request, computer);
        continue;
      }
      if (!computer || !session) {
        throw engineFailure("engine_failed", "The plan's CLI answered without a session.");
      }
      for (const toolCall of calls) yield { type: "tool_call", call: toolCall };
      const state: EngineState = {
        computer,
        session,
        given: plan.given,
        hash: plan.hash,
        ...(calls.length ? { prompt: plan.ask.id, from: next, calls: calls.map((c) => c.id) } : {}),
      };
      yield { type: "state", state: { data: state } };
      return;
    }
  },
};
