import type {
  AttachmentOutput,
  AttachmentStreamOutput,
  RunInput,
} from "./attachments/index.ts";
import type { ContentInput } from "./content/index.ts";
import type { CopilotzEvent } from "./events/index.ts";

export type CliRunHandle = Readonly<{
  eventId: string;
  correlationId: string;
  outputs: ReadableStream<AttachmentOutput>;
  done: Promise<void>;
  cancel(reason?: string): Promise<void>;
}>;

export type CliPerformRun = (
  input: RunInput,
) => Promise<CliRunHandle>;

export type CliRunScope = Readonly<
  Omit<
    RunInput,
    "content" | "messageId" | "correlationId" | "deduplicationId"
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
  performRun: CliPerformRun;
  /** Existing thread and participant scope used for every prompt. */
  scope: CliRunScope;
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
  output: AttachmentOutput,
): output is AttachmentStreamOutput {
  return output.type === "stream.output" && "payload" in output &&
    Boolean(
      output.payload && typeof output.payload === "object" &&
        typeof (output.payload as { getReader?: unknown }).getReader ===
          "function",
    );
}

function eventAgentName(event: CopilotzEvent): string {
  const agent = eventPayload(event).agent;
  return agent && typeof agent === "object" && !Array.isArray(agent) &&
      typeof (agent as Record<string, unknown>).name === "string"
    ? String((agent as Record<string, unknown>).name)
    : "assistant";
}

function threadLabel(scope: CliRunScope): string {
  if (typeof scope.thread === "string") return scope.thread;
  return scope.thread.externalId ?? scope.thread.id;
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
      "namespace: " + options.scope.namespace,
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
  };

  const renderDelta = (event: CopilotzEvent): void => {
    const payload = eventPayload(event);
    const agentName = eventAgentName(event);
    const text = typeof payload.text === "string" ? payload.text : "";
    const isReasoning = event.type === "reasoning.delta";
    if (currentAgent !== agentName) {
      io.write("\n" + color("assistant " + agentName, "green") + "\n");
      currentAgent = agentName;
      inReasoning = false;
    }
    if (isReasoning && !inReasoning) {
      io.write(color("thinking> ", "dim"));
      inReasoning = true;
    } else if (!isReasoning && inReasoning) {
      io.write("\n" + color("answer> ", "cyan"));
      inReasoning = false;
    } else if (!isReasoning && !sawVisibleOutput) {
      io.write(color("answer> ", "cyan"));
    }
    if (!isReasoning) sawVisibleOutput = true;
    io.write(text);
  };

  const renderToolCall = (event: CopilotzEvent): void => {
    const payload = eventPayload(event);
    const phase = typeof payload.phase === "string" ? payload.phase : "";
    if (phase === "delta" || phase === "discarded") return;

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
    if (draftId && renderedToolDrafts.has(draftId)) return;
    if (draftId) renderedToolDrafts.add(draftId);

    if (inReasoning || sawVisibleOutput) io.write("\n");
    inReasoning = false;
    sawVisibleOutput = false;
    printLine(color("tool>", "yellow") + " " + name);
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
    if (
      event.type === "copilotz.core.llm.generate.invoked" ||
      event.type === "copilotz.core.llm.session.invoked"
    ) {
      printLine(color("thinking… " + eventAgentName(event), "dim"));
      return;
    }
    if (event.type === "copilotz.core.tool.call.failed") {
      printLine(color("tool execution failed", "yellow"));
    }
  };

  const renderOutput = async (output: AttachmentOutput): Promise<void> => {
    if (!isStreamOutput(output)) {
      renderEvent(output);
      return;
    }
    const decoder = new TextDecoder();
    const reader = output.payload.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = decoder.decode(next.value, { stream: true });
        if (!chunk) continue;
        sawVisibleOutput = true;
        io.write(chunk);
      }
      const tail = decoder.decode();
      if (tail) {
        sawVisibleOutput = true;
        io.write(tail);
      }
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
    const handle = await options.performRun({
      ...options.scope,
      content,
    });
    activeEventId = handle.eventId;
    history.push({
      input: label,
      at: now().toISOString(),
      eventId: handle.eventId,
    });
    for await (const output of handle.outputs) await renderOutput(output);
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
