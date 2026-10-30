/**
 * The person's own terminal on their computer, in a space's folder: the
 * toolkit's `Terminal` over their shell there (`shell.ts`), its history kept
 * per computer and space. It's their shell, not their agents': agents have
 * their own, and their jobs show under Jobs. On someone else's computer
 * (shared into the space), it says whose it runs as.
 */
import { type ReactNode, useMemo } from "react";
import { Kbd, Terminal } from "../../../../../hosts/web/mod.ts";
import type { Computer } from "../../collections/computer.ts";
import type { TerminalResult } from "../../shared/workloads.ts";
import { nameOf, type Work } from "./names.ts";
import { shellSession } from "./shell.ts";

export function TerminalTab(
  { computer, space, spaceName, folder, work, active, theirs }: {
    computer: Computer;
    /** Whose computer it is, when it isn't the person's. */
    theirs?: string;
    space: string;
    spaceName: string;
    /** The space's folder on it, which the prompt starts from. */
    folder: string;
    work: Work;
    active: boolean;
  },
): ReactNode {
  const session = useMemo(
    () => shellSession((input) => work<TerminalResult>("terminal", input), { folder }),
    [work, folder],
  );
  return (
    <div className="computer-terminal">
      <Terminal
        session={session}
        label={`Terminal on ${nameOf(computer)}, in ${spaceName}`}
        historyKey={`${computer._id}:${space}`}
        autoFocus={active}
        className="computer-terminal-screen"
      />
      <p className="computer-terminal-hint">
        {theirs
          ? `Your own shell on ${theirs}'s computer, running as ${theirs}`
          : "Your own shell"}, in {spaceName}'s folder: a command at a time. <Kbd>↑</Kbd>{" "}
        <Kbd>↓</Kbd> history · <Kbd>Ctrl</Kbd> <Kbd>C</Kbd> stops · <Kbd>Ctrl</Kbd> <Kbd>L</Kbd>
        {" "}
        clears. For servers, start a job.
      </p>
    </div>
  );
}
