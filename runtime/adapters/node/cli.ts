import { cwd, stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

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

export type StartInteractiveCliOptions = StartPortableInteractiveCliOptions;

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
  return startPortableInteractiveCli({
    ...options,
    io: createInteractiveCliIo(),
  });
}
