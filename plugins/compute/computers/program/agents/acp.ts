/**
 * The engines' sessions on this computer, as an ACP client keeps them: each
 * a peer (engines.ts starts it: our adapter, or a native agent's process),
 * fixed to its engine, model, instructions and tools, with a door of its own
 * to the tools' MCP server (mcp.ts).
 *
 * A prompt runs one at a time per session, and runs on whatever happens to
 * whoever asked: its events are kept until they're received (a fresh
 * session's first says which it is), and read in steps (steps.ts): a step
 * ends with the turn, or with the model's calls to the agent's tools, which
 * the prompt waits on, held. The same prompt (its `id`) again settles its
 * calls' `results` and streams on from `from`. Leaving a step's stream only
 * detaches; `cancel` stops the prompt.
 *
 * A session not here whose engine can load sessions (a restart, an idle
 * one closed) is loaded again; one whose engine can't, or that doesn't
 * match, is `stale`. A session with no prompt for `idleMs` closes. A
 * prompt whose events not yet received pass `maxBuffer` is `lost`, and its
 * session goes.
 */
import type { CallResult, PromptInput } from "../../shared/workloads.ts";
import type { Engines, Found } from "./engines.ts";
import { createMcp, type Endpoint, type HeldCall } from "./mcp.ts";
import { permit } from "./permission.ts";
import { agentError, failureOf, rpcError } from "./rpc.ts";
import {
  emit as add,
  lostPrompt,
  newPrompt,
  type Prompt as Steps,
  received,
  type Said,
  step,
  wake,
} from "./steps.ts";
import type { Peer, PromptResponse, SessionUpdate, Usage } from "./types.ts";

export type SessionsOptions = {
  engines: Engines;
  log: (line: string) => void;
  /** A session with no prompt this long closes (30 minutes unless given). */
  idleMs?: number;
  /** A prompt nobody came back to this long goes, with its session (a day unless given). */
  heldMs?: number;
  /** The most a prompt's events not yet received may be (4 MiB unless given). */
  maxBuffer?: number;
  /** How long after a step's first call others still join it (150 ms unless given). */
  stepMs?: number;
};

export type Sessions = {
  /** A prompt's events, as JSON lines: a new prompt, or the same `id` again. Never fails: says so. */
  prompt(input: PromptInput, signal: AbortSignal): ReadableStream<Uint8Array>;
  /** Stops what the session is doing, and fails its held calls. */
  cancel(session: string): void;
  /** Closes every session. */
  stop(): Promise<void>;
};

/** What failures are called, on the stream. */
const CODES = new Set([
  "missing",
  "signed_out",
  "limit",
  "model",
  "stale",
  "lost",
  "busy",
  "failed",
]);

/** The updates a prompt passes on: what the model says and thinks, and its calls' progress. */
const PASSED = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

/** How long a cancelled prompt gets to end before its session goes. */
const CANCELLING = 10_000;

/** A prompt, as its session runs it. */
type Prompt = Steps & {
  session?: Session;
  /** When a cancelled prompt that hasn't ended is ended here. */
  cancelling?: ReturnType<typeof setTimeout>;
};

type Session = {
  id: string;
  engine: string;
  model: string;
  instructions: string;
  tools: string;
  peer: Peer;
  endpoint: Endpoint;
  prompt?: Prompt;
  /** Whether a `session/prompt` is under way (updates before it, a load's history, aren't). */
  prompting: boolean;
  used: number;
  closed: boolean;
};

type Checked = Omit<PromptInput, "results"> & { results: CallResult[] };

/** `value` as JSON with its objects' keys in order: two tools lists alike are alike. */
function canonical(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
        : v,
  );
}

/** A prompt's input, checked. */
function check(input: PromptInput): Checked {
  const bad = (what: string): never => {
    throw agentError("failed", what);
  };
  if (!input || typeof input !== "object") bad("The prompt's input must be an object");
  const { engine, model, session, instructions, tools, prompt, id, from, results } = input;
  if (typeof id !== "string" || !id) bad("id is required");
  if (typeof engine !== "string" || !engine) bad("engine is required");
  if (typeof model !== "string" || !model) bad("model is required");
  if (session !== undefined && (typeof session !== "string" || !session)) bad("session is text");
  if (typeof instructions !== "string") bad("instructions is text");
  if (
    !Array.isArray(tools) ||
    !tools.every((t) => typeof t?.name === "string" && t.name && t.name.length <= 128)
  ) bad("tools are MCP tools, each with a name");
  if (!Array.isArray(prompt)) bad("prompt is a list of content blocks");
  if (from !== undefined && (!Number.isInteger(from) || from < 0)) bad("from is an event's index");
  if (
    results !== undefined &&
    (!Array.isArray(results) ||
      !results.every((r) => typeof r?.id === "string" && typeof r.content === "string"))
  ) bad("results are each a call's id and content");
  return { ...input, results: results ?? [] };
}

/** The failure an error stands for, on the stream. */
function codeOf(error: unknown): string {
  const said = failureOf(error) ?? (error as { code?: unknown })?.code;
  if (typeof said === "string" && CODES.has(said)) return said;
  // ACP's "authentication required".
  if (said === -32000 && /auth/i.test((error as Error)?.message ?? "")) return "signed_out";
  return "failed";
}

/** A prompt's token use, as an adapter says it (`_meta.copilotz`) or ACP does (`usage`). */
function usageOf(answer: PromptResponse & { usage?: Record<string, number> }): Usage | undefined {
  const ours = answer?._meta?.copilotz?.usage;
  if (ours) return ours;
  const acp = answer?.usage;
  if (!acp) return undefined;
  return {
    input: acp.inputTokens ?? 0,
    output: acp.outputTokens ?? 0,
    ...(acp.cachedReadTokens ? { cached: acp.cachedReadTokens } : {}),
    ...(acp.cachedWriteTokens ? { cacheWrite: acp.cachedWriteTokens } : {}),
  };
}

/** The sessions of this computer's engines. */
export function createSessions(options: SessionsOptions): Sessions {
  const { engines, log } = options;
  const idleMs = options.idleMs ?? 30 * 60_000;
  const heldMs = options.heldMs ?? 24 * 60 * 60_000;
  const maxBuffer = options.maxBuffer ?? 4 * 1024 * 1024;
  const stepMs = options.stepMs ?? 150;
  const mcp = createMcp(log);
  const sessions = new Map<string, Session>();
  const prompts = new Map<string, Prompt>();
  /** Which prompt runs in a session (one starting or loading too). */
  const busy = new Map<string, string>();
  /** Calls held, by id, and whose prompt they're in. */
  const calls = new Map<string, Prompt>();
  let stopping = false;

  /** Answers the prompt's held calls as failed. */
  const failHeld = (prompt: Prompt, why: string) => {
    for (const [id, held] of prompt.held) {
      calls.delete(id);
      held.settle({ content: why, isError: true });
    }
    prompt.held.clear();
  };

  /** Closes a session: its door, its peer. */
  const drop = (session: Session) => {
    if (session.closed) return;
    session.closed = true;
    if (sessions.get(session.id) === session) sessions.delete(session.id);
    if (session.prompt && busy.get(session.id) === session.prompt.id) busy.delete(session.id);
    session.endpoint.close();
    void session.peer.close();
  };

  /** Adds an event; past `maxBuffer` unreceived, the prompt is lost, and its session goes. */
  const emit = (prompt: Prompt, event: Said) => {
    if (event.type === "done" || event.type === "failed") clearTimeout(prompt.cancelling);
    if (!add(prompt, event, maxBuffer)) return;
    failHeld(prompt, "The prompt was dropped");
    if (prompt.session) drop(prompt.session);
    log(`a prompt's events passed ${maxBuffer} bytes unreceived; its session was dropped`);
  };

  /** The model called one of the agent's tools: it's held, and the prompt says so. */
  const called = (session: Session | undefined, held: HeldCall) => {
    const prompt = session?.prompting ? session.prompt : undefined;
    if (!prompt || prompt.ended) {
      return held.settle({ content: "No prompt is running in this session", isError: true });
    }
    prompt.held.set(held.id, held);
    calls.set(held.id, prompt);
    emit(prompt, {
      type: "call",
      call: { id: held.id, name: held.name, arguments: held.arguments },
    });
  };

  /** Picks the session's model, when the agent offers models (ACP's `models`). */
  const chooseModel = async (peer: Peer, id: string, offered: unknown, model: string) => {
    const { availableModels, currentModelId } = (offered ?? {}) as {
      availableModels?: { modelId: string; name?: string }[];
      currentModelId?: string;
    };
    if (!Array.isArray(availableModels) || !availableModels.length) return;
    const match = availableModels.find((m) => m?.modelId === model) ??
      availableModels.find((m) => m?.name?.toLowerCase() === model.toLowerCase());
    if (!match) {
      throw agentError(
        "model",
        `${model} isn't a model of this plan: ${availableModels.map((m) => m.modelId).join(", ")}`,
      );
    }
    if (match.modelId === currentModelId) return;
    await peer.request("session/set_model", { sessionId: id, modelId: match.modelId })
      .catch((error) => {
        if ((error as { code?: number })?.code !== -32601) throw error;
      });
  };

  /** A session for `input`: a fresh one, or (`load`) the one it names, taken up again. */
  const open = async (input: Checked, found: Found, load?: string): Promise<Session> => {
    const cwd = await engines.folder(found, input.instructions);
    let session: Session | undefined;
    const endpoint = await mcp.open(input.tools, (held) => called(session, held));
    let peer: Peer;
    try {
      peer = engines.launch(found);
    } catch (error) {
      endpoint.close();
      throw error;
    }
    const tools = new Set(input.tools.map((tool) => tool.name));
    peer.onRequest((method, params) => {
      if (method === "session/request_permission") {
        return Promise.resolve(permit(params, tools, (line) => log(`${input.engine}: ${line}`)));
      }
      log(`${input.engine} asked ${method}: refused`);
      return Promise.reject(rpcError(`Not supported: ${method}`, undefined, -32601));
    });
    peer.onNotification((method, params) => {
      const update = params?.update as SessionUpdate | undefined;
      if (
        method !== "session/update" || !session?.prompting || params?.sessionId !== session.id ||
        !session.prompt || !PASSED.has(update?.sessionUpdate as string)
      ) return;
      emit(session.prompt, { type: "update", update });
    });
    try {
      // deno-lint-ignore no-explicit-any
      const init = await peer.request<{ agentCapabilities?: Record<string, any> }>(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
      );
      const able = init?.agentCapabilities ?? {};
      if (able.mcpCapabilities?.http === false) {
        throw agentError("failed", `${input.engine} can't reach the agent's tools over HTTP`);
      }
      const params = {
        cwd,
        mcpServers: [endpoint.server],
        _meta: { copilotz: { instructions: input.instructions, model: input.model } },
      };
      let answer: { sessionId?: string; models?: unknown } | null;
      if (load) {
        if (!able.loadSession) throw agentError("stale", `${input.engine} can't load a session`);
        answer = await peer.request<typeof answer>("session/load", { ...params, sessionId: load })
          .catch((error) => {
            const code = codeOf(error);
            throw code === "failed" ? agentError("stale", `${load} couldn't be loaded`) : error;
          });
      } else answer = await peer.request<typeof answer>("session/new", params);
      const id = load ?? answer?.sessionId;
      if (typeof id !== "string" || !id) throw agentError("failed", "The agent gave no session");
      await chooseModel(peer, id, answer?.models, input.model);
      session = {
        id,
        engine: input.engine,
        model: input.model,
        instructions: input.instructions,
        tools: canonical(input.tools),
        peer,
        endpoint,
        prompting: false,
        used: Date.now(),
        closed: false,
      };
      const opened = session;
      const before = sessions.get(id);
      if (before) drop(before);
      sessions.set(id, opened);
      // Its process gone, it's gone: a later prompt loads it again.
      void peer.closed.then((how) => {
        if (!opened.closed && how.error) log(`${input.engine} stopped: ${how.error}`);
        drop(opened);
      });
      if (stopping) drop(opened);
      return opened;
    } catch (error) {
      endpoint.close();
      await peer.close();
      throw error;
    }
  };

  /** Runs a new prompt to its end. */
  const run = async (prompt: Prompt, input: Checked) => {
    let claimed = input.session;
    if (claimed) {
      const running = busy.get(claimed);
      if (running && running !== prompt.id) {
        return emit(prompt, {
          type: "failed",
          code: "busy",
          message: "Another prompt is running in this session",
        });
      }
      busy.set(claimed, prompt.id);
    }
    try {
      let session = input.session ? sessions.get(input.session) : undefined;
      if (
        session &&
        (session.engine !== input.engine || session.model !== input.model ||
          session.instructions !== input.instructions || session.tools !== canonical(input.tools))
      ) {
        return emit(prompt, {
          type: "failed",
          code: "stale",
          message: "That session has another engine, model, instructions or tools",
        });
      }
      if (!session) {
        const found = await engines.find(input.engine);
        session = await open(input, found, input.session);
        if (!input.session) {
          emit(prompt, { type: "session", session: session.id });
          busy.set(claimed = session.id, prompt.id);
        }
      }
      if (session.prompt && session.prompt !== prompt) prompts.delete(session.prompt.id);
      session.prompt = prompt;
      prompt.session = session;
      session.used = Date.now();
      if (session.closed || prompt.ended) return;
      session.prompting = true;
      try {
        const answer = await session.peer.request<PromptResponse>("session/prompt", {
          sessionId: session.id,
          prompt: input.prompt,
        });
        const usage = usageOf(answer);
        emit(prompt, {
          type: "done",
          stopReason: String(answer?.stopReason ?? "end_turn"),
          ...(usage ? { usage } : {}),
        });
      } finally {
        session.prompting = false;
        session.used = Date.now();
      }
    } catch (error) {
      emit(prompt, {
        type: "failed",
        code: codeOf(error),
        message: (error as Error)?.message ?? String(error),
      });
    } finally {
      failHeld(prompt, "The prompt ended before this call was answered");
      if (claimed && busy.get(claimed) === prompt.id) busy.delete(claimed);
    }
  };

  /** A step of `prompt`, from `from`. */
  const attach = (prompt: Prompt, from: number, signal: AbortSignal) =>
    step(prompt, from, {
      signal,
      stepMs,
      left: () => {
        if (prompt.session) prompt.session.used = Date.now();
      },
    });

  // Idle sessions close; prompts nobody came back to go.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const session of [...sessions.values()]) {
      const prompt = session.prompt;
      if (!prompt || prompt.ended) {
        if (now - session.used >= idleMs) drop(session);
      } else if (!prompt.reader && now - prompt.used >= heldMs) {
        emit(prompt, { type: "failed", code: "failed", message: "Nobody came back to it" });
        drop(session);
      }
    }
    for (const [id, prompt] of prompts) {
      if (prompt.ended && !prompt.reader && now - prompt.used >= idleMs) prompts.delete(id);
    }
  }, Math.max(10, Math.min(60_000, idleMs / 2)));
  sweeper.unref?.();

  return {
    prompt(input, signal) {
      let checked: Checked;
      try {
        if (stopping) throw agentError("failed", "The computer is stopping");
        checked = check(input);
      } catch (error) {
        const failed: Prompt = newPrompt("");
        emit(failed, {
          type: "failed",
          code: codeOf(error),
          message: (error as Error)?.message ?? String(error),
        });
        return attach(failed, 0, signal);
      }
      // What the plugin answers goes first: the prompt goes on with it.
      for (const result of checked.results) {
        const prompt = calls.get(result.id);
        const held = prompt?.held.get(result.id);
        calls.delete(result.id);
        prompt?.held.delete(result.id);
        held?.settle({ content: result.content, ...(result.isError ? { isError: true } : {}) });
      }
      const from = checked.from ?? 0;
      let prompt = prompts.get(checked.id);
      if (prompt) received(prompt, from);
      else if (from > 0 || checked.results.length) {
        // A prompt it no longer has: what it said is gone.
        prompt = lostPrompt(checked.id, from);
      } else {
        prompts.set(checked.id, prompt = newPrompt(checked.id));
        void run(prompt, checked);
      }
      return attach(prompt, from, signal);
    },
    cancel(id) {
      const session = sessions.get(id);
      const prompt = session?.prompt;
      if (!session || !prompt || prompt.ended) return;
      session.peer.notify("session/cancel", { sessionId: id });
      failHeld(prompt, "The turn was cancelled");
      // Not ended in time: it's ended here, and its session goes.
      clearTimeout(prompt.cancelling);
      prompt.cancelling = setTimeout(() => {
        emit(prompt, { type: "done", stopReason: "cancelled" });
        drop(session);
      }, CANCELLING);
    },
    async stop() {
      stopping = true;
      clearInterval(sweeper);
      const all = [...sessions.values()];
      for (const session of all) drop(session);
      await Promise.allSettled(all.map((session) => session.peer.closed));
      for (const prompt of prompts.values()) {
        clearTimeout(prompt.cancelling);
        failHeld(prompt, "The computer stopped");
        wake(prompt);
      }
      await mcp.close();
    },
  };
}
