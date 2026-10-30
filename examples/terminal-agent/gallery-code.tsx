/**
 * The gallery's code and terminals: `CodeBlock` as a command and its output
 * (a tail, with an error), a change line by line, and a file with its lines
 * numbered; and a `Terminal` over a session that runs here, in the page:
 * `echo`, `count` (output as it comes), `fail`, `ask` (input), `help`. Its
 * xterm.js loads when the gallery shows it.
 */
import { type ReactNode, useState } from "react";
import {
  Badge,
  CodeBlock,
  Terminal,
  type TerminalOutput,
  type TerminalSession,
} from "../../hosts/web/mod.ts";

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

const NOTES = "# Notes\n\nWhat's left before the launch:\n- copy\n- pricing\n";

/** A shell that lives in the page, to try the terminal with. */
function pretend(): TerminalSession {
  let where = "gallery";
  let stop: (() => void) | undefined;
  let answer: ((line: string) => void) | undefined;
  const run = async (line: string, out: TerminalOutput) => {
    const [name, ...rest] = line.trim().split(/\s+/);
    if (name === "echo") return out.write(`${rest.join(" ")}\n`);
    if (name === "cd") {
      where = rest[0] ? `gallery/${rest[0]}` : "gallery";
      return;
    }
    if (name === "fail") {
      out.error("something went wrong\n");
      return out.note("exit 1");
    }
    if (name === "count") {
      const stopped = new AbortController();
      stop = () => stopped.abort();
      for (let i = 1; i <= 5 && !stopped.signal.aborted; i++) {
        out.write(`${i}\n`);
        await wait(500, stopped.signal);
      }
      stop = undefined;
      if (stopped.signal.aborted) out.note("stopped");
      return;
    }
    if (name === "ask") {
      out.write("Your name: ");
      const said = await new Promise<string>((resolve) => answer = resolve);
      answer = undefined;
      return out.write(`Hello, ${said || "you"}.\n`);
    }
    out.write(
      `${name === "help" ? "" : `${name}: not here. `}Try echo, cd, count, fail or ask.\n`,
    );
  };
  return {
    prompt: () => where,
    run,
    input: (line) => answer?.(line),
    interrupt: () => stop?.(),
  };
}

export function CodeGallery(): ReactNode {
  const [session] = useState(pretend);
  return (
    <div className="gallery-grid" data-gallery="code">
      <CodeBlock
        title={<code>$ npm test</code>}
        actions={<Badge tone="destructive">exit 1</Badge>}
        code={[
          { text: "running 12 tests\n" },
          ...Array.from({ length: 10 }, (_, i) => ({ text: `test ${i + 1} ... ok\n` })),
          { text: "test 11 ... FAILED\n", tone: "error" as const },
          { text: "1 failed, 11 passed\n" },
        ]}
        lines={5}
        from="end"
        footer="2.4 s"
        copy
      />
      <CodeBlock
        title={
          <span>
            Edited <code>src/a.ts</code>
          </span>
        }
        code={[
          { text: "export const greet = (name: string) =>\n" },
          { text: "  `Hi, ${name}`;\n", tone: "removed" },
          { text: "  `Hello, ${name}!`;\n", tone: "added" },
        ]}
      />
      <CodeBlock
        title={<span>notes.md</span>}
        code={NOTES}
        numbers
        copy
      />
      <div className="gallery-terminal">
        <Terminal session={session} label="A terminal, in the page" autoFocus={false} />
      </div>
    </div>
  );
}
