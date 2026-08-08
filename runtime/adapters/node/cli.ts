import { cwd, stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import type { CopilotzApplication } from "../../application/index.ts";
import {
  type InteractiveCliHandle,
  type InteractiveCliIo,
  type InteractiveCliOptions,
  startInteractiveCli as startPortableInteractiveCli,
} from "../../cli.ts";

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

export type StartPortableInteractiveCliOptions = Omit<
  InteractiveCliOptions,
  "io"
>;

export type StartApplicationInteractiveCliOptions =
  & Omit<InteractiveCliOptions, "io" | "performRun" | "inspect">
  & Readonly<{
    application: CopilotzApplication;
    /** Stable ID of the agent receiving this CLI's prompts. */
    agent: string;
  }>;

export type StartInteractiveCliOptions =
  | StartPortableInteractiveCliOptions
  | StartApplicationInteractiveCliOptions;

/** Creates readline I/O for Node and runtimes implementing its compatibility API. */
export function createInteractiveCliIo(): InteractiveCliIo {
  const readline = createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
    historySize: 500,
    removeHistoryDuplicates: true,
    completer(line) {
      const hits = COMMANDS.filter((command) => command.startsWith(line));
      return [hits.length ? [...hits] : [...COMMANDS], line];
    },
  });
  return Object.freeze({
    question: (prompt: string) => readline.question(prompt),
    write: (value: string) => {
      stdout.write(value);
    },
    close: () => readline.close(),
    clear: () => {
      stdout.write("\x1bc");
    },
    cwd,
  });
}

/** Starts the portable CLI state machine with Node-compatible terminal I/O. */
export function startInteractiveCli(
  options: StartInteractiveCliOptions,
): InteractiveCliHandle {
  if ("application" in options) {
    const { application, agent, ...portable } = options;
    return startPortableInteractiveCli({
      ...portable,
      io: createInteractiveCliIo(),
      performRun: (input) => application.run(input),
      async inspect() {
        const resolved = await application.capabilities.resolve({ agent });
        return Object.freeze({
          agent: resolved.agent,
          agents: Object.freeze(
            resolved.agents.map((entry) => entry.resource),
          ),
          tools: Object.freeze(
            resolved.tools.map((entry) => entry.resource),
          ),
          skills: Object.freeze(
            resolved.skills.map((entry) => entry.resource),
          ),
        });
      },
    });
  }
  return startPortableInteractiveCli({
    ...options,
    io: createInteractiveCliIo(),
  });
}
