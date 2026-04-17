import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import type {
  MessagePayload,
  Event,
} from "@/types/index.ts";

type CliPerformRun = (
  message: MessagePayload,
  options?: { stream?: boolean; ackMode?: "immediate" | "onComplete" },
) => Promise<{
  threadId: string;
  events: AsyncIterable<unknown>;
  done: Promise<void>;
}>;

type CliAgent = {
  id?: string;
  name: string;
  role?: string | null;
};

export interface InteractiveCliOptions {
  performRun: CliPerformRun;
  initialMessage?:
    | (MessagePayload & {
      banner?: string | null;
      quitCommand?: string;
      threadExternalId?: string;
    })
    | string;
  agents?: CliAgent[];
  tools?: Array<{ id?: string; key?: string; name?: string }>;
  banner?: string | null;
  cwd?: string;
}

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  bold: "\x1b[1m",
};

function color(text: string, tone: keyof typeof ANSI): string {
  return `${ANSI[tone]}${text}${ANSI.reset}`;
}

function safeJson(value: unknown, max = 140): string {
  let rendered = "";
  try {
    rendered = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    rendered = String(value);
  }
  return rendered.length > max ? `${rendered.slice(0, max - 3)}...` : rendered;
}

function extractToolName(event: Event): string {
  const payload = event.payload as Record<string, unknown> | null;
  const toolCall = payload?.toolCall as Record<string, unknown> | undefined;
  const tool = toolCall?.tool as Record<string, unknown> | undefined;
  return typeof tool?.name === "string"
    ? tool.name
    : typeof tool?.id === "string"
    ? tool.id
    : "tool";
}

function extractToolArgs(event: Event): string {
  const payload = event.payload as Record<string, unknown> | null;
  const toolCall = payload?.toolCall as Record<string, unknown> | undefined;
  return safeJson(toolCall?.args ?? {});
}

class CopilotzInteractiveCli {
  private readonly rl: Interface;
  private stopped = false;
  private readonly history: Array<{ input: string; threadId: string; at: string }> = [];
  private quitCommand = "quit";
  private banner: string | null;
  private threadExternalId = crypto.randomUUID().slice(0, 24);
  private sessionSender: MessagePayload["sender"] | undefined = {
    type: "user",
    name: "user",
  };
  private sessionParticipants: string[] | undefined = undefined;
  private currentAgent = "";
  private inReasoning = false;
  private sawVisibleOutput = false;
  private activeThreadId = "";

  constructor(private readonly options: InteractiveCliOptions) {
    this.rl = createInterface({
      input: stdin,
      output: stdout,
      terminal: true,
      historySize: 500,
      removeHistoryDuplicates: true,
      completer: (line) => {
        const commands = [
          "/help",
          "/agents",
          "/tools",
          "/history",
          "/status",
          "/compose",
          "/clear",
          "/exit",
        ];
        const hits = commands.filter((command) => command.startsWith(line));
        return [hits.length > 0 ? hits : commands, line];
      },
    });
    this.banner = options.banner ?? null;
    this.initializeFromInitialMessage();
  }

  private initializeFromInitialMessage(): void {
    const { initialMessage } = this.options;
    if (!initialMessage || typeof initialMessage === "string") {
      return;
    }

    if (typeof initialMessage.quitCommand === "string") {
      this.quitCommand = initialMessage.quitCommand;
    }
    if (typeof initialMessage.banner === "string" || initialMessage.banner === null) {
      this.banner = initialMessage.banner;
    }
    if (
      typeof initialMessage.threadExternalId === "string" &&
      initialMessage.threadExternalId.trim().length > 0
    ) {
      this.threadExternalId = initialMessage.threadExternalId;
    } else if (
      typeof initialMessage.thread?.externalId === "string" &&
      initialMessage.thread.externalId.trim().length > 0
    ) {
      this.threadExternalId = initialMessage.thread.externalId;
    }

    if (initialMessage.sender && typeof initialMessage.sender === "object") {
      this.sessionSender = {
        id: initialMessage.sender.id ?? undefined,
        externalId: initialMessage.sender.externalId ?? null,
        type: initialMessage.sender.type ?? "user",
        name: initialMessage.sender.name ?? null,
        identifierType: initialMessage.sender.identifierType ?? undefined,
        metadata:
          initialMessage.sender.metadata &&
            typeof initialMessage.sender.metadata === "object"
            ? initialMessage.sender.metadata as Record<string, unknown>
            : null,
      };
    }

    if (
      Array.isArray(initialMessage.thread?.participants) &&
      initialMessage.thread.participants.length > 0
    ) {
      this.sessionParticipants = initialMessage.thread.participants.slice();
    }
  }

  stop(): void {
    this.stopped = true;
    this.rl.close();
  }

  async run(): Promise<void> {
    if (this.banner) {
      this.printLine(this.banner);
    }
    this.renderSessionHeader();

    const { initialMessage } = this.options;
    if (typeof initialMessage === "string" && initialMessage.trim().length > 0) {
      await this.send(initialMessage);
    } else if (initialMessage && typeof initialMessage === "object") {
      const { banner: _banner, quitCommand: _quit, threadExternalId: _threadExternalId, ...rest } =
        initialMessage;
      await this.send(rest as MessagePayload);
    }

    while (!this.stopped) {
      const input = (await this.rl.question(color("copilotz> ", "cyan"))).trim();
      if (!input) continue;
      if (input.toLowerCase() === this.quitCommand || input === "/exit") {
        this.printLine(color("Ending session. Goodbye.", "dim"));
        break;
      }
      if (input.startsWith("/")) {
        const handled = await this.handleCommand(input);
        if (handled) continue;
      }
      await this.send(input);
    }

    this.rl.close();
  }

  private renderSessionHeader(): void {
    const lines = [
      color("Copilotz Interactive Session", "bold"),
      `${color("cwd", "dim")}: ${this.options.cwd ?? Deno.cwd()}`,
      `${color("thread", "dim")}: ${this.threadExternalId}`,
      `${color("commands", "dim")}: /help /agents /tools /history /status /compose /clear /exit`,
      "",
    ];
    this.printLine(lines.join("\n"));
  }

  private async handleCommand(commandLine: string): Promise<boolean> {
    const [command] = commandLine.split(/\s+/, 1);
    switch (command) {
      case "/help":
        this.printLine([
          color("Commands", "bold"),
          "/help       show this help",
          "/agents     list loaded agents",
          "/tools      summarize available tools",
          "/history    show recent prompts from this session",
          "/status     show current session info",
          "/compose    enter multiline compose mode",
          "/clear      clear the terminal",
          "/exit       end the session",
        ].join("\n"));
        return true;
      case "/agents":
        this.printAgents();
        return true;
      case "/tools":
        this.printTools();
        return true;
      case "/history":
        this.printHistory();
        return true;
      case "/status":
        this.printStatus();
        return true;
      case "/compose": {
        const composed = await this.composeMessage();
        if (composed) {
          await this.send(composed);
        }
        return true;
      }
      case "/clear":
        stdout.write("\x1bc");
        this.renderSessionHeader();
        return true;
      default:
        return false;
    }
  }

  private printAgents(): void {
    const agents = this.options.agents ?? [];
    if (agents.length === 0) {
      this.printLine(color("No agents loaded.", "dim"));
      return;
    }
    const lines = [
      color("Agents", "bold"),
      ...agents.map((agent) =>
        `- ${agent.name}${agent.role ? ` (${agent.role})` : ""}${
          agent.id && agent.id !== agent.name ? ` [${agent.id}]` : ""
        }`
      ),
    ];
    this.printLine(lines.join("\n"));
  }

  private printTools(): void {
    const explicitTools = this.options.tools ?? [];
    const lines = [
      color("Tools", "bold"),
      `Loaded explicit tools: ${explicitTools.length}`,
    ];
    if (explicitTools.length > 0) {
      lines.push(
        ...explicitTools.slice(0, 30).map((tool) =>
          `- ${tool.key ?? tool.id ?? tool.name ?? "tool"}`
        ),
      );
      if (explicitTools.length > 30) {
        lines.push(`- ...and ${explicitTools.length - 30} more`);
      }
    }
    lines.push(
      color(
        "Native tools are also available depending on each agent's allowedTools configuration.",
        "dim",
      ),
    );
    this.printLine(lines.join("\n"));
  }

  private printHistory(): void {
    if (this.history.length === 0) {
      this.printLine(color("No prompts sent yet.", "dim"));
      return;
    }
    const lines = [
      color("Recent Prompts", "bold"),
      ...this.history.slice(-10).map((entry, index) =>
        `${index + 1}. [${entry.at}] ${entry.input}`
      ),
    ];
    this.printLine(lines.join("\n"));
  }

  private printStatus(): void {
    const lines = [
      color("Session Status", "bold"),
      `cwd: ${this.options.cwd ?? Deno.cwd()}`,
      `thread external id: ${this.threadExternalId}`,
      `last thread id: ${this.activeThreadId || "(none yet)"}`,
      `history entries: ${this.history.length}`,
      `loaded agents: ${(this.options.agents ?? []).length}`,
    ];
    this.printLine(lines.join("\n"));
  }

  private async composeMessage(): Promise<string | null> {
    this.printLine(
      color(
        "Compose mode. Enter /send on its own line to submit or /cancel to abort.",
        "dim",
      ),
    );
    const lines: string[] = [];
    while (!this.stopped) {
      const line = await this.rl.question(color("... ", "magenta"));
      if (line === "/cancel") {
        this.printLine(color("Compose cancelled.", "dim"));
        return null;
      }
      if (line === "/send") {
        return lines.join("\n").trim();
      }
      lines.push(line);
    }
    return null;
  }

  private buildOutboundMessage(message: string | MessagePayload): MessagePayload {
    if (typeof message === "string") {
      return {
        content: message,
        sender: this.sessionSender ?? { type: "user", name: "user" },
        thread: this.sessionParticipants
          ? {
            externalId: this.threadExternalId,
            participants: this.sessionParticipants,
          }
          : { externalId: this.threadExternalId },
      };
    }

    const participants = Array.isArray(message.thread?.participants) &&
        message.thread.participants.length > 0
      ? message.thread.participants
      : this.sessionParticipants;

    return {
      ...message,
      sender: message.sender ?? this.sessionSender ?? { type: "user", name: "user" },
      thread: {
        ...(message.thread ?? {}),
        externalId: this.threadExternalId,
        ...(participants ? { participants } : {}),
      },
    };
  }

  private resetRenderState(): void {
    this.currentAgent = "";
    this.inReasoning = false;
    this.sawVisibleOutput = false;
  }

  private renderToken(event: Event): void {
    const payload = event.payload as {
      token?: string;
      isComplete?: boolean;
      isReasoning?: boolean;
      agent?: { name?: string | null };
    };
    const agentName = payload.agent?.name ?? "assistant";
    const token = payload.token ?? "";
    const isReasoning = Boolean(payload.isReasoning);
    const isComplete = Boolean(payload.isComplete);

    if (isComplete) {
      if (this.inReasoning) {
        stdout.write("\n");
      }
      if (this.sawVisibleOutput) {
        stdout.write("\n");
      }
      this.inReasoning = false;
      return;
    }

    if (this.currentAgent !== agentName) {
      stdout.write(`\n${color(`assistant ${agentName}`, "green")}\n`);
      this.currentAgent = agentName;
      this.inReasoning = false;
    }

    if (isReasoning && !this.inReasoning) {
      stdout.write(color("thinking> ", "dim"));
      this.inReasoning = true;
    } else if (!isReasoning && this.inReasoning) {
      stdout.write(`\n${color("answer> ", "cyan")}`);
      this.inReasoning = false;
    } else if (!isReasoning && !this.sawVisibleOutput) {
      stdout.write(color("answer> ", "cyan"));
    }

    if (!isReasoning) {
      this.sawVisibleOutput = true;
    }
    stdout.write(token);
  }

  private renderEvent(event: Event): void {
    if (event.type === "TOKEN") {
      this.renderToken(event);
      return;
    }

    if (event.type === "LLM_CALL") {
      const payload = event.payload as Record<string, unknown> | null;
      const agent = payload?.agent as Record<string, unknown> | undefined;
      const agentName = typeof agent?.name === "string" ? agent.name : "assistant";
      this.printLine(color(`thinking… ${agentName}`, "dim"));
      return;
    }

    if (event.type === "TOOL_CALL") {
      this.printLine(
        `${color("tool>", "yellow")} ${extractToolName(event)} ${color(extractToolArgs(event), "dim")}`,
      );
      return;
    }
  }

  private async send(message: string | MessagePayload): Promise<void> {
    const outbound = this.buildOutboundMessage(message);
    const text = typeof outbound.content === "string"
      ? outbound.content.replace(/\s+/g, " ").trim()
      : "[non-text message]";
    this.history.push({
      input: text,
      at: new Date().toISOString(),
      threadId: this.activeThreadId,
    });

    this.resetRenderState();
    this.printLine("");

    const handle = await this.options.performRun(
      outbound,
      { stream: true, ackMode: "onComplete" },
    );
    this.activeThreadId = handle.threadId;
    this.history[this.history.length - 1]!.threadId = handle.threadId;

    for await (const event of handle.events) {
      this.renderEvent(event as Event);
    }
    await handle.done;
    this.printLine(color("─".repeat(60), "dim"));
  }

  private printLine(line: string): void {
    stdout.write(`${line}\n`);
  }
}

export function startInteractiveCli(options: InteractiveCliOptions): {
  stop: () => void;
  closed: Promise<void>;
} {
  const cli = new CopilotzInteractiveCli(options);
  return {
    stop: () => cli.stop(),
    closed: cli.run(),
  };
}
