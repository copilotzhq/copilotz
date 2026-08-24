import type {
  ApplicationOutput,
  CopilotzApplication,
} from "@copilotz/copilotz/application";
import type { ContentInput } from "@copilotz/copilotz/content";
import type { CopilotzEvent } from "@copilotz/copilotz/events";
import { type CoreMessageInput, message } from "../resources/inputs/index.ts";
import { CORE_LLM_STREAM_METADATA_SCHEMA } from "../internal/workflow-metadata.ts";

export type CliMessageScope = Readonly<
  Omit<
    CoreMessageInput,
    "content" | "id" | "correlationId" | "deduplicationId"
  >
>;

export type CliAgent = Readonly<{
  id?: string;
  name: string;
  role?: string | null;
}>;

export type CliTool = Readonly<{
  id?: string;
  key?: string;
  name?: string;
}>;

export type CliSkill = Readonly<{
  name: string;
  description?: string;
}>;

export type CliInspection = Readonly<{
  agent?: CliAgent;
  agents: readonly CliAgent[];
  tools: readonly CliTool[];
  skills: readonly CliSkill[];
}>;

export type CliInspect = () => CliInspection | Promise<CliInspection>;

/** Host-owned input/output capability. Core never imports a terminal runtime. */
export type InteractiveCliIo = Readonly<{
  question(prompt: string): Promise<string>;
  write(value: string): void;
  close(): void;
  clear?(): void;
  cwd?(): string;
}>;

export interface InteractiveCliOptions {
  io: InteractiveCliIo;
  /** Application ingress used for every typed Core message. */
  application:
    & Pick<CopilotzApplication, "send">
    & Readonly<{
      namespace?: string;
    }>;
  /** Existing Core thread and participant scope used for every prompt. */
  scope: CliMessageScope;
  initialContent?: ContentInput | readonly ContentInput[];
  /** Canonical effective-capability lookup used by terminal commands. */
  inspect?: CliInspect;
  banner?: string | null;
  quitCommand?: string;
  cwd?: string;
  now?: () => Date;
}

export type InteractiveCliHandle = Readonly<{
  stop(): void;
  closed: Promise<void>;
}>;

const COMMANDS = [
  "/help",
  "/agents",
  "/tools",
  "/skills",
  "/history",
  "/status",
  "/compose",
  "/clear",
  "/exit",
] as const;

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
  bold: "\x1b[1m",
};

function color(text: string, tone: keyof typeof ANSI): string {
  return ANSI[tone] + text + ANSI.reset;
}

function eventPayload(event: CopilotzEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" &&
      !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
}

function isStreamOutput(
  output: ApplicationOutput,
): output is Extract<ApplicationOutput, { type: "stream.output" }> {
  return output.type === "stream.output" && "payload" in output &&
    Boolean(
      output.payload && typeof output.payload === "object" &&
        typeof (output.payload as { getReader?: unknown }).getReader ===
          "function",
    );
}

function llmStreamLane(
  output: Extract<ApplicationOutput, { type: "stream.output" }>,
): "content" | "reasoning" | "tool-calls" | null {
  const role = output.role.trim().toLowerCase();
  if (
    role === "content" || role === "reasoning" || role === "tool-calls"
  ) return role;
  const metadataLane = output.metadata.lane;
  const lane = typeof metadataLane === "string"
    ? metadataLane.trim().toLowerCase()
    : "";
  return lane === "content" || lane === "reasoning" || lane === "tool-calls"
    ? lane
    : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function coreStreamAgentName(
  output: Extract<ApplicationOutput, { type: "stream.output" }>,
): string | undefined {
  const core = record(output.metadata.copilotzCore);
  if (core?.schema !== CORE_LLM_STREAM_METADATA_SCHEMA) return undefined;
  return nonEmptyText(record(core.agent)?.name);
}

function eventAgentName(event: CopilotzEvent): string {
  const agent = eventPayload(event).agent;
  return agent && typeof agent === "object" && !Array.isArray(agent) &&
      typeof (agent as Record<string, unknown>).name === "string"
    ? String((agent as Record<string, unknown>).name)
    : "assistant";
}

/** Uses a scope/inspection fallback only for legacy or custom streams. */
function responseAgentName(
  scope: CliMessageScope,
  inspection: CliInspection,
): string {
  const agents = [
    ...(inspection.agent ? [inspection.agent] : []),
    ...inspection.agents,
  ];
  const recipientIds = new Set(scope.recipientIds ?? []);
  const recipient = agents.find((agent) =>
    Boolean(agent.id) && recipientIds.has(agent.id!)
  );
  return recipient?.name ?? inspection.agent?.name ??
    (scope.recipientIds?.[0] ?? "assistant");
}

function threadLabel(scope: CliMessageScope): string {
  if (typeof scope.thread === "string") return scope.thread;
  return scope.thread.externalId ?? scope.thread.id ?? "(new thread)";
}

/** Creates the interactive state machine over injected terminal I/O. */
export function createInteractiveCli(options: InteractiveCliOptions): Readonly<{
  stop(): void;
  run(): Promise<void>;
}> {
  const io = options.io;
  const now = options.now ?? (() => new Date());
  const quitCommand = options.quitCommand?.trim().toLowerCase() || "quit";
  let stopped = false;
  let ioClosed = false;
  const history: Array<{ input: string; eventId: string; at: string }> = [];
  let currentAgent = "";
  let inReasoning = false;
  let sawVisibleOutput = false;
  let activeEventId = "";
  const renderedToolDrafts = new Set<string>();
  const askToolDrafts = new Map<string, {
    raw: string;
    sequence: number;
    renderedMessage: string;
    rendered: boolean;
  }>();

  const printLine = (line: string): void => io.write(line + "\n");
  const cwd = (): string => options.cwd ?? io.cwd?.() ?? ".";
  const inspect = async (): Promise<CliInspection> =>
    await options.inspect?.() ?? Object.freeze({
      agents: Object.freeze([]),
      tools: Object.freeze([]),
      skills: Object.freeze([]),
    });

  const stop = (): void => {
    stopped = true;
    if (ioClosed) return;
    ioClosed = true;
    io.close();
  };

  const renderSessionHeader = (): void => {
    printLine([
      color("Copilotz Interactive Session", "bold"),
      color("cwd", "dim") + ": " + cwd(),
      color("thread", "dim") + ": " + threadLabel(options.scope),
      color("commands", "dim") + ": " + COMMANDS.join(" "),
      "",
    ].join("\n"));
  };

  const printAgents = async (): Promise<void> => {
    const inspection = await inspect();
    const currentId = inspection.agent?.id ?? inspection.agent?.name;
    const agents = [
      ...(inspection.agent ? [inspection.agent] : []),
      ...inspection.agents,
    ].filter((agent, index, values) =>
      values.findIndex((candidate) =>
        (candidate.id ?? candidate.name) === (agent.id ?? agent.name)
      ) === index
    );
    if (!agents.length) {
      printLine(color("No agent capabilities available.", "dim"));
      return;
    }
    printLine([
      color("Agents", "bold"),
      ...agents.map((agent) =>
        "- " + agent.name +
        ((agent.id ?? agent.name) === currentId ? " (current)" : "") +
        (agent.role ? " (" + agent.role + ")" : "") +
        (agent.id && agent.id !== agent.name ? " [" + agent.id + "]" : "")
      ),
    ].join("\n"));
  };

  const printTools = async (): Promise<void> => {
    const tools = (await inspect()).tools;
    const lines = [
      color("Tools", "bold"),
      "Available tools: " + tools.length,
      ...tools.slice(0, 30).map((tool) =>
        "- " + (tool.key ?? tool.id ?? tool.name ?? "tool")
      ),
    ];
    if (tools.length > 30) {
      lines.push("- ...and " + (tools.length - 30) + " more");
    }
    printLine(lines.join("\n"));
  };

  const printSkills = async (): Promise<void> => {
    const skills = (await inspect()).skills;
    if (!skills.length) {
      printLine(color("No skills available.", "dim"));
      return;
    }
    printLine([
      color("Skills", "bold"),
      ...skills.map((skill) =>
        "- " + skill.name +
        (skill.description ? ": " + skill.description : "")
      ),
    ].join("\n"));
  };

  const printHistory = (): void => {
    if (!history.length) {
      printLine(color("No prompts sent yet.", "dim"));
      return;
    }
    printLine([
      color("Recent Prompts", "bold"),
      ...history.slice(-10).map((entry, index) =>
        (index + 1) + ". [" + entry.at + "] " + entry.input
      ),
    ].join("\n"));
  };

  const printStatus = async (): Promise<void> => {
    const inspection = await inspect();
    printLine([
      color("Session Status", "bold"),
      "cwd: " + cwd(),
      "namespace: " + (options.application.namespace ?? "(default)"),
      "thread: " + threadLabel(options.scope),
      "last event id: " + (activeEventId || "(none yet)"),
      "history entries: " + history.length,
      "available agents: " + inspection.agents.length,
      "available tools: " + inspection.tools.length,
      "available skills: " + inspection.skills.length,
    ].join("\n"));
  };

  const composeMessage = async (): Promise<string | null> => {
    printLine(color(
      "Compose mode. Enter /send on its own line to submit or /cancel to abort.",
      "dim",
    ));
    const lines: string[] = [];
    while (!stopped) {
      const line = await io.question(color("... ", "magenta"));
      if (line === "/cancel") {
        printLine(color("Compose cancelled.", "dim"));
        return null;
      }
      if (line === "/send") return lines.join("\n").trim();
      lines.push(line);
    }
    return null;
  };

  const resetRenderState = (): void => {
    currentAgent = "";
    inReasoning = false;
    sawVisibleOutput = false;
    renderedToolDrafts.clear();
    askToolDrafts.clear();
  };

  const renderAgentHeader = (agentName: string): void => {
    if (currentAgent === agentName) return;
    if (inReasoning || sawVisibleOutput) io.write("\n");
    currentAgent = agentName;
    inReasoning = false;
    sawVisibleOutput = false;
  };

  const renderDelta = (event: CopilotzEvent): void => {
    const payload = eventPayload(event);
    const agentName = eventAgentName(event);
    const text = typeof payload.text === "string" ? payload.text : "";
    const isReasoning = event.type === "reasoning.delta";
    renderAgentHeader(agentName);
    if (isReasoning && !inReasoning) {
      io.write(color(currentAgent + " thinking> ", "dim"));
      inReasoning = true;
    } else if (!isReasoning && inReasoning) {
      io.write("\n" + color(currentAgent + "> ", "cyan"));
      inReasoning = false;
    } else if (!isReasoning && !sawVisibleOutput) {
      io.write(color(currentAgent + "> ", "cyan"));
    }
    if (!isReasoning) sawVisibleOutput = true;
    io.write(text);
  };

  const renderGenericToolCall = (
    name: string,
    draftId: string,
  ): void => {
    if (draftId && renderedToolDrafts.has(draftId)) return;
    if (draftId) renderedToolDrafts.add(draftId);
    if (inReasoning || sawVisibleOutput) io.write("\n");
    inReasoning = false;
    sawVisibleOutput = false;
    printLine(color("tool>", "yellow") + " " + name);
  };

  const jsonStringProperty = (
    input: string,
    property: "target" | "message",
    complete: boolean,
  ): string | undefined => {
    const match = new RegExp(`"${property}"\\s*:\\s*"`).exec(input);
    if (!match) return undefined;
    const start = match.index + match[0].length;
    let decoded = "";
    for (let index = start; index < input.length; index += 1) {
      const char = input[index];
      if (char === '"') {
        const last = decoded.charCodeAt(decoded.length - 1);
        return last >= 0xd800 && last <= 0xdbff ? undefined : decoded;
      }
      if (char !== "\\") {
        decoded += char;
        continue;
      }
      const escaped = input[index + 1];
      if (escaped === undefined) return complete ? undefined : decoded;
      const escapes: Record<string, string> = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      if (escaped === "u") {
        const hex = input.slice(index + 2, index + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          return complete ? undefined : decoded;
        }
        decoded += String.fromCharCode(Number.parseInt(hex, 16));
        index += 5;
        continue;
      }
      if (!(escaped in escapes)) return complete ? undefined : decoded;
      decoded += escapes[escaped];
      index += 1;
    }
    if (complete) return undefined;
    const last = decoded.charCodeAt(decoded.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? decoded.slice(0, -1) : decoded;
  };

  const renderAskDraft = (
    payload: Record<string, unknown>,
    askingAgentName: string,
  ): void => {
    const draftId = nonEmptyText(payload.draftId);
    const phase = nonEmptyText(payload.phase) ?? "";
    const delta = typeof payload.delta === "string" ? payload.delta : "";
    if (!draftId) return;
    const sequence = typeof payload.sequence === "number" &&
        Number.isSafeInteger(payload.sequence)
      ? payload.sequence
      : -1;
    let draft = askToolDrafts.get(draftId);
    if (!draft || phase === "start") {
      draft = { raw: "", sequence: -1, renderedMessage: "", rendered: false };
      askToolDrafts.set(draftId, draft);
    }
    if (phase === "discarded") return;
    if (sequence >= 0 && sequence <= draft.sequence) return;
    if (sequence >= 0) draft.sequence = sequence;
    if (phase === "start") draft.raw = delta;
    else if (phase === "delta") draft.raw += delta;

    const target = jsonStringProperty(draft.raw, "target", true);
    const message = jsonStringProperty(draft.raw, "message", false);
    if (target && message !== undefined) {
      if (!draft.rendered) {
        if (inReasoning || sawVisibleOutput) io.write("\n");
        inReasoning = false;
        sawVisibleOutput = false;
        io.write(color(`${askingAgentName} → @${target}> `, "yellow"));
        draft.rendered = true;
      }
      if (message.length > draft.renderedMessage.length) {
        io.write(message.slice(draft.renderedMessage.length));
        draft.renderedMessage = message;
        sawVisibleOutput = true;
      }
    }
    if (phase === "complete" && !draft.rendered) {
      renderGenericToolCall("ask", draftId);
    }
  };

  const renderToolCallPayload = (
    payload: Record<string, unknown>,
    askingAgentName = currentAgent || "assistant",
  ): void => {
    const phase = typeof payload.phase === "string" ? payload.phase : "";
    const name = typeof payload.toolName === "string"
      ? payload.toolName
      : typeof payload.name === "string"
      ? payload.name
      : typeof payload.tool === "string"
      ? payload.tool
      : "tool";
    const draftId = typeof payload.draftId === "string"
      ? payload.draftId
      : typeof payload.toolCallId === "string"
      ? payload.toolCallId
      : typeof payload.providerAttemptId === "string" &&
          typeof payload.callIndex === "number"
      ? `${payload.providerAttemptId}:${payload.callIndex}`
      : "";
    if (name === "ask") {
      renderAskDraft(payload, askingAgentName);
      return;
    }
    if (phase === "delta" || phase === "discarded") return;
    renderGenericToolCall(name, draftId);
  };

  const renderToolCall = (event: CopilotzEvent): void => {
    renderToolCallPayload(eventPayload(event));
  };

  const renderEvent = (event: CopilotzEvent): void => {
    if (event.type === "text.delta" || event.type === "reasoning.delta") {
      renderDelta(event);
      return;
    }
    if (event.type === "tool_call.delta") {
      renderToolCall(event);
      return;
    }
  };

  const renderToolCallStream = async (
    output: Extract<ApplicationOutput, { type: "stream.output" }>,
    askingAgentName: string,
  ): Promise<void> => {
    if (output.mediaType !== "application/x-ndjson") return;
    const decoder = new TextDecoder();
    const reader = output.payload.getReader();
    let buffered = "";
    const renderLine = (line: string): void => {
      const normalized = line.trim();
      if (!normalized) return;
      try {
        const parsed: unknown = JSON.parse(normalized);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          renderToolCallPayload(
            parsed as Record<string, unknown>,
            askingAgentName,
          );
        }
      } catch {
        // Ignore malformed provider frames instead of leaking raw protocol data.
      }
    };
    const consume = (text: string): void => {
      buffered += text;
      while (true) {
        const delimiter = buffered.indexOf("\n");
        if (delimiter < 0) return;
        renderLine(buffered.slice(0, delimiter));
        buffered = buffered.slice(delimiter + 1);
      }
    };
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        consume(decoder.decode(next.value, { stream: true }));
      }
      consume(decoder.decode());
      renderLine(buffered);
    } finally {
      reader.releaseLock();
    }
  };

  const renderOutput = async (
    output: ApplicationOutput,
    respondingAgentName: string,
  ): Promise<void> => {
    if (!isStreamOutput(output)) {
      renderEvent(output);
      return;
    }
    const lane = llmStreamLane(output);
    const streamAgentName = coreStreamAgentName(output) ?? respondingAgentName;
    if (lane === "tool-calls") {
      await renderToolCallStream(output, streamAgentName);
      return;
    }
    let started = false;
    const writeStreamText = (text: string): void => {
      if (!text) return;
      if (!started) {
        renderAgentHeader(streamAgentName);
        if (lane === "reasoning") {
          if (sawVisibleOutput) io.write("\n");
          if (!inReasoning) {
            io.write(color(currentAgent + " thinking> ", "dim"));
          }
          inReasoning = true;
        } else if (lane === "content") {
          if (inReasoning) {
            io.write("\n" + color(currentAgent + "> ", "cyan"));
          } else if (!sawVisibleOutput) {
            io.write(color(currentAgent + "> ", "cyan"));
          }
          inReasoning = false;
          sawVisibleOutput = true;
        } else {
          if (inReasoning) io.write("\n");
          inReasoning = false;
          sawVisibleOutput = true;
        }
        started = true;
      }
      io.write(text);
    };
    const decoder = new TextDecoder();
    const reader = output.payload.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = decoder.decode(next.value, { stream: true });
        writeStreamText(chunk);
      }
      const tail = decoder.decode();
      writeStreamText(tail);
    } finally {
      reader.releaseLock();
    }
  };

  const send = async (
    content: ContentInput | readonly ContentInput[],
    historyLabel?: string,
  ): Promise<void> => {
    const label = historyLabel ??
      (typeof content === "string"
        ? content.replace(/\s+/g, " ").trim()
        : "[rich content]");
    resetRenderState();
    printLine("");
    const respondingAgentName = responseAgentName(
      options.scope,
      await inspect(),
    );
    const handle = await options.application.send(message({
      ...options.scope,
      content,
    }));
    activeEventId = handle.eventId;
    history.push({
      input: label,
      at: now().toISOString(),
      eventId: handle.eventId,
    });
    for await (const output of handle.outputs) {
      await renderOutput(output, respondingAgentName);
    }
    await handle.done;
    if (inReasoning || sawVisibleOutput) io.write("\n");
    printLine(color("─".repeat(60), "dim"));
  };

  const handleCommand = async (line: string): Promise<boolean> => {
    const [command] = line.split(/\s+/, 1);
    switch (command) {
      case "/help":
        printLine([
          color("Commands", "bold"),
          "/help       show this help",
          "/agents     list current and available agents",
          "/tools      summarize available tools",
          "/skills     list available skills",
          "/history    show recent prompts from this session",
          "/status     show current session info",
          "/compose    enter multiline compose mode",
          "/clear      clear the terminal",
          "/exit       end the session",
        ].join("\n"));
        return true;
      case "/agents":
        await printAgents();
        return true;
      case "/tools":
        await printTools();
        return true;
      case "/skills":
        await printSkills();
        return true;
      case "/history":
        printHistory();
        return true;
      case "/status":
        await printStatus();
        return true;
      case "/compose": {
        const composed = await composeMessage();
        if (composed) await send(composed);
        return true;
      }
      case "/clear":
        if (io.clear) io.clear();
        else io.write("\x1bc");
        renderSessionHeader();
        return true;
      default:
        return false;
    }
  };

  const run = async (): Promise<void> => {
    try {
      if (options.banner) printLine(options.banner);
      renderSessionHeader();
      if (options.initialContent !== undefined) {
        await send(options.initialContent, "[initial content]");
      }
      while (!stopped) {
        let answer: string;
        try {
          answer = await io.question(color("copilotz> ", "cyan"));
        } catch (error) {
          if (stopped) break;
          throw error;
        }
        const input = answer.trim();
        if (!input) continue;
        if (input.toLowerCase() === quitCommand || input === "/exit") {
          printLine(color("Ending session. Goodbye.", "dim"));
          stopped = true;
          break;
        }
        if (input.startsWith("/") && await handleCommand(input)) continue;
        await send(input);
      }
    } finally {
      stop();
    }
  };

  return Object.freeze({ stop, run });
}

export function startInteractiveCli(
  options: InteractiveCliOptions,
): InteractiveCliHandle {
  const cli = createInteractiveCli(options);
  return Object.freeze({ stop: cli.stop, closed: cli.run() });
}
