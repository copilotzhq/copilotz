/// <reference lib="dom" />
/**
 * Connecting a computer, in a dialog: a one-time code (`computer.code`) in
 * the command to run on it, with a copy button, and how long the code has
 * left; spent, a new one on a tap. Where to run it, briefly: a terminal on
 * that computer, from the app's code; its spaces' folders go in ~/Copilotz.
 * The person's computers are live, so the moment a new one comes online it
 * says "Connected", with a way to open it. A `notice` goes over the steps
 * (connecting into a shared space shares the computer there).
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Button,
  clock,
  CodeBlock,
  Dialog,
  Icon,
  message,
  Notice,
  Skeleton,
  Spinner,
} from "../../../../../hosts/web/mod.ts";
import type { Computer } from "../../collections/computer.ts";
import type { Info } from "../../shared/workloads.ts";
import { nameOf, systemOf, tilde } from "./names.ts";

type Code = { code: string; expires: string; url?: string };

/** Now, every second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

export function ConnectDialog(
  { open, onClose, call, computers, here, where, notice }: {
    open: boolean;
    onClose(): void;
    call<R = unknown>(action: string, input?: unknown): Promise<R>;
    /** The person's computers, live: a new one online is the one this code connected. */
    computers: Computer[];
    /** Where the person works: the space it's connected to, and the link to it. */
    here?: string;
    /** That space's name, as the title says it. */
    where?: string;
    /** What to know first, over the steps. */
    notice?: ReactNode;
  },
): ReactNode {
  const [code, setCode] = useState<Code>();
  const [error, setError] = useState<string>();
  const before = useRef(new Set<string>());
  const now = useNow(open && !!code);

  const fresh = async () => {
    setError(undefined);
    setCode(undefined);
    before.current = new Set(computers.map((c) => c._id));
    try {
      setCode(await call<Code>("computer.code", here ? { in: here } : {}));
    } catch (e) {
      setError(message(e));
    }
  };
  useEffect(() => {
    if (open) void fresh();
    else setCode(undefined);
  }, [open]);

  const arrived = code ? computers.find((c) => !before.current.has(c._id) && c.online) : undefined;
  const left = code ? Math.max(0, Date.parse(code.expires) - now) : 0;
  const expired = !!code && !arrived && left <= 0;
  const app = code?.url ?? location.origin;
  const command = code ? `deno task computer connect ${app} --code ${code.code}` : "";
  const info = arrived?.info as Partial<Info> | undefined;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={arrived
        ? "Your computer is connected"
        : where
        ? `Connect a computer to ${where}`
        : "Connect a computer"}
      description={arrived
        ? undefined
        : "Your agents can then work on it: run commands and jobs, read and write files, browse " +
          "and search, each space in a folder of its own. They ask you before commands and changes."}
      footer={arrived
        ? (
          <>
            <Button onClick={onClose}>Done</Button>
            <Button
              variant="primary"
              icon="terminal"
              href={`/computer/${encodeURIComponent(arrived._id)}${
                here ? `?in=${encodeURIComponent(here)}` : ""
              }`}
              onClick={onClose}
            >
              Open {nameOf(arrived)}
            </Button>
          </>
        )
        : <Button onClick={onClose}>Close</Button>}
    >
      {arrived
        ? (
          <div className="connect-done" role="status">
            <span className="connect-done-icon">
              <Icon name="check" size={22} />
            </span>
            <div>
              <p className="connect-done-name">Connected: {nameOf(arrived)}</p>
              <p className="connect-done-facts">
                {[systemOf(info?.os), info?.arch, info?.root ? tilde(info.root) : undefined]
                  .filter(Boolean).join(" · ")}
              </p>
            </div>
          </div>
        )
        : (
          <>
            {notice ? <div className="connect-notice">{notice}</div> : null}
            <ol className="connect-steps">
              <li>
                <span className="connect-step-number" aria-hidden="true">1</span>
                <div className="connect-step">
                  <p>
                    In a terminal on that computer, from your copy of Copilotz (the app's code),
                    run:
                  </p>
                  {error
                    ? (
                      <Notice
                        tone="destructive"
                        role="alert"
                        action={<Button size="sm" onClick={() => void fresh()}>Try again</Button>}
                      >
                        Couldn't make a code: {error}
                      </Notice>
                    )
                    : code
                    ? (
                      <CodeBlock
                        className="connect-command"
                        label="The command to run"
                        code={[
                          { text: "$ ", tone: "muted" },
                          { text: `deno task computer connect ${app} \\\n    --code ` },
                          { text: code.code, tone: expired ? "muted" : "accent" },
                        ]}
                        copy={expired ? false : command}
                      />
                    )
                    : <Skeleton height={44} radius="lg" />}
                  {code
                    ? (
                      <p className="connect-expiry" aria-live="polite">
                        {expired
                          ? (
                            <>
                              <span>This code has run out.</span>
                              <Button size="sm" icon="refresh" onClick={() => void fresh()}>
                                New code
                              </Button>
                            </>
                          )
                          : (
                            <>
                              <Icon name="lock" size={13} />
                              <span>
                                Works once, for <b className="connect-left">{clock(left)}</b> more
                              </span>
                            </>
                          )}
                      </p>
                    )
                    : null}
                </div>
              </li>
              <li>
                <span className="connect-step-number" aria-hidden="true">2</span>
                <div className="connect-step">
                  <p>
                    Leave it running. Each space gets a folder in <code>~/Copilotz</code>{" "}
                    on that computer (<code>--root</code> puts them elsewhere), and next time{" "}
                    <code>deno task computer</code> starts it again.
                  </p>
                </div>
              </li>
              {code && !expired
                ? (
                  <li className="connect-waiting" role="status">
                    <Spinner size={15} />
                    Waiting for your computer…
                  </li>
                )
                : null}
            </ol>
          </>
        )}
    </Dialog>
  );
}
