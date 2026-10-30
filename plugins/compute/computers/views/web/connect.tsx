/**
 * Connecting a computer, in a dialog: a one-time code (`computer.code`) in
 * the one line that installs the computer program and connects it, for the
 * system the visitor's browser runs on (macOS, Linux or Windows; another on a
 * tap), with a copy button, and how long the code has left; spent, a new one
 * on a tap. Behind a disclosure, the program to download instead (each
 * binary's architecture, size and SHA-256), and how to run it: honest that a
 * browser's download isn't signed yet, so the line is the smooth way. Then
 * "waiting for your computer…", and the moment it's online, "Connected", with
 * a way to open it; what it does, and how to stop it. An app with no release
 * of the program (`downloads`) gets the command for its code instead. A
 * `notice` goes over the steps (connecting into a shared space shares the
 * computer there).
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  appBase,
  Button,
  bytes,
  clock,
  CodeBlock,
  type CodePart,
  CopyButton,
  Dialog,
  Icon,
  message,
  Notice,
  Skeleton,
  Spinner,
  Tabs,
} from "../../../../../hosts/web/mod.ts";
import type { Computer } from "../../collections/computer.ts";
import { type Binary, installCommand, OS_NAMES } from "../../program/release.ts";
import type { Info } from "../../shared/workloads.ts";
import { nameOf, systemOf, tilde } from "./names.ts";
import { archName, type System, SYSTEMS, visitorArch, visitorSystem } from "./platform.ts";

/** A path the app serves, under the app's address (which may be an org's: `/o/<org>`). */
const within = (path: string, app: string) =>
  new URL(path.replace(/^\//, ""), app.endsWith("/") ? app : `${app}/`).href;

/** A release of the program, as `computer.code` says it: its base, version and binaries. */
type Release = { base: string; version: string; binaries: Binary[] };
/** A code, and (on an org) the folder its spaces go in there, plain, as the program takes it. */
type Code = { code: string; expires: string; url?: string; folder?: string; downloads?: Release };

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

/** Where the line runs, on each system. */
const WHERE: Record<System, string> = {
  darwin: "In Terminal on that Mac, run:",
  linux: "In a terminal on that computer, run:",
  win32: "In PowerShell on that PC, run:",
};

/**
 * The command as it shows: on two lines where it reads better (as a shell
 * reads it too: after a pipe, or PowerShell's backtick), its code standing
 * out (muted once it's spent). It's copied as one line.
 */
function parts(command: string, code: string, spent: boolean, prompt: string): CodePart[] {
  const shown = command.replace(" | sh -s -- ", " |\n    sh -s -- ")
    .replace("))) ", "))) `\n    ");
  const at = shown.lastIndexOf(code);
  return [
    { text: prompt, tone: "muted" },
    { text: shown.slice(0, at) },
    { text: code, tone: spent ? "muted" : "accent" },
    { text: shown.slice(at + code.length) },
  ];
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
  const [system, setSystem] = useState<System>(() => visitorSystem() ?? "darwin");
  const [arch, setArch] = useState<string>();
  // The one this code connected, once it's come: it stays, whatever it does after.
  const [came, setCame] = useState<string>();
  const before = useRef(new Set<string>());
  const now = useNow(open && !!code && !came);

  const fresh = async () => {
    setError(undefined);
    setCode(undefined);
    setCame(undefined);
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
  useEffect(() => void visitorArch().then(setArch), []);

  const online = code && !came
    ? computers.find((c) => !before.current.has(c._id) && c.online)
    : undefined;
  useEffect(() => {
    if (online) setCame(online._id);
  }, [online?._id]);
  const arrived = came ? computers.find((c) => c._id === came) : undefined;
  const left = code ? Math.max(0, Date.parse(code.expires) - now) : 0;
  const expired = !!code && !arrived && left <= 0;
  const app = code?.url ?? appBase();
  const release = code?.downloads;
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
              {release
                ? (
                  <p className="connect-done-facts">
                    It runs in the background there, and starts again when you log in on it.
                  </p>
                )
                : null}
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
                  {release
                    ? (
                      <div className="connect-step-head">
                        <p className="connect-step-title">Install the computer program</p>
                        <Tabs
                          label="That computer's system"
                          value={system}
                          onChange={setSystem}
                          tabs={SYSTEMS.map((os) => ({ value: os, label: OS_NAMES[os] }))}
                          className="connect-systems"
                        />
                      </div>
                    )
                    : null}
                  <p>
                    {release
                      ? WHERE[system]
                      : "In a terminal on that computer, from your copy of the app's code, run:"}
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
                    ? <Command code={code} app={app} system={system} spent={expired} />
                    : <Skeleton height={64} radius="lg" />}
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
                                The code works once, for{" "}
                                <b className="connect-left">{clock(left)}</b> more
                              </span>
                            </>
                          )}
                      </p>
                    )
                    : null}
                  {release && code
                    ? (
                      <Direct
                        release={release}
                        system={system}
                        mine={system === visitorSystem()}
                        arch={arch}
                        app={app}
                        code={code.code}
                        folder={code.folder}
                        spent={expired}
                      />
                    )
                    : null}
                </div>
              </li>
              <li>
                <span className="connect-step-number" aria-hidden="true">2</span>
                <div className="connect-step">
                  <p>
                    {release
                      ? (
                        <>
                          It connects, then keeps running in the background, and starts when you log
                          in. Each space gets a folder in{" "}
                          <code>
                            {system === "win32" ? "%USERPROFILE%\\Copilotz" : "~/Copilotz"}
                          </code>{" "}
                          on it.
                        </>
                      )
                      : (
                        <>
                          Leave it running. Each space gets a folder in <code>~/Copilotz</code>{" "}
                          on that computer (<code>--root</code> puts them elsewhere), and next time
                          {" "}
                          <code>deno task computer</code> starts it again.
                        </>
                      )}
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
            {release
              ? (
                <p className="connect-stop">
                  <Icon name="info" size={14} />
                  <span>
                    To stop it, run <code>computer uninstall</code>{" "}
                    on it: it stops, and no longer starts at login. Forgetting it here, on its page,
                    disconnects it for good.
                  </span>
                </p>
              )
              : null}
          </>
        )}
    </Dialog>
  );
}

/** The line to run (the program's, from the app's release; or, without one, from its code). */
function Command(
  { code, app, system, spent }: { code: Code; app: string; system: System; spent: boolean },
): ReactNode {
  const release = code.downloads;
  if (!release) {
    const folder = code.folder ? ` --folder ${code.folder}` : "";
    const command = `deno task computer connect ${app} --code ${code.code}${folder}`;
    return (
      <CodeBlock
        className="connect-command"
        label="The command to run"
        code={[
          { text: "$ ", tone: "muted" },
          { text: `deno task computer connect ${app} \\\n    --code ` },
          { text: code.code, tone: spent ? "muted" : "accent" },
          ...(folder ? [{ text: folder }] : []),
        ]}
        copy={spent ? false : command}
      />
    );
  }
  const base = within(release.base, app);
  const windows = system === "win32";
  const command = installCommand(windows ? "powershell" : "sh", {
    app,
    code: code.code,
    base,
    folder: code.folder,
  });
  return (
    <CodeBlock
      className="connect-command"
      label="The command that installs it"
      code={parts(command, code.code, spent, windows ? "PS> " : "$ ")}
      copy={spent ? false : command}
    />
  );
}

/**
 * The binaries to download instead, for `system` (the visitor's own first,
 * when it's theirs and their architecture is known), each with its size and
 * SHA-256, and how to run one; behind a disclosure.
 */
function Direct(
  { release, system, mine, arch, app, code, folder, spent }: {
    release: Release;
    system: System;
    /** Whether it's the visitor's own system, and their architecture, when it's known. */
    mine: boolean;
    arch?: string;
    app: string;
    code: string;
    folder?: string;
    spent: boolean;
  },
): ReactNode {
  const base = within(release.base, app);
  const binaries = release.binaries.filter((b) => b.os === system)
    .sort((a, b) => Number(mine && b.arch === arch) - Number(mine && a.arch === arch));
  if (!binaries.length) return null;
  const [first] = binaries;
  // The visitor's, when it's this system: theirs by architecture, or the only one there is.
  const yours = mine
    ? binaries.length === 1 ? first : binaries.find((b) => b.arch === arch)
    : undefined;
  const windows = system === "win32";
  const path = windows ? `$HOME\\Downloads\\${first.file}` : `~/Downloads/${first.file}`;
  const named = folder ? ` --folder ${folder}` : "";
  const run = windows
    ? `& "${path}" install ${app} --code ${code}${named}`
    : `chmod +x ${path} && ${path} install ${app} --code ${code}${named}`;
  return (
    <details className="connect-direct">
      <summary>
        <Icon name="chevron" size={14} className="connect-direct-chevron" />
        Download it instead
        <span className="connect-direct-version">v{release.version}</span>
      </summary>
      <div className="connect-direct-body">
        <ul className="connect-binaries" aria-label={`For ${OS_NAMES[system]}`}>
          {binaries.map((b) => (
            <li key={b.file} className="connect-binary">
              <div className="connect-binary-text">
                <span className="connect-binary-name">
                  {archName(b.os, b.arch)}
                  {yours === b ? <span className="connect-binary-yours">this computer</span> : null}
                </span>
                <span className="connect-binary-facts">
                  <code>{b.file}</code> · {bytes(b.size)}
                </span>
                <span className="connect-binary-sha" title={b.sha256}>
                  SHA-256 <code>{b.sha256.slice(0, 12)}…{b.sha256.slice(-8)}</code>
                  <CopyButton text={b.sha256} label="Copy SHA-256" />
                </span>
              </div>
              <Button size="sm" icon="download" href={`${base}${b.file}`} download={b.file}>
                Download
              </Button>
            </li>
          ))}
        </ul>
        <p>Then, where you saved it, run it with your code:</p>
        <CodeBlock
          className="connect-command"
          label="How to run the download"
          code={parts(run, code, spent, windows ? "PS> " : "$ ")}
          copy={spent ? false : run}
        />
        <p className="connect-unsigned">
          <Icon name="alert" size={13} />
          <span>
            {windows
              ? "The program isn't signed yet, so Windows may say it doesn't recognize it (More " +
                "info, then Run anyway). The command above doesn't need that."
              : system === "darwin"
              ? "The program isn't signed yet, so macOS won't open it from a browser's download " +
                "until you allow it in System Settings, Privacy & Security. The command above " +
                "doesn't need that."
              : "It's the same program the command above installs, checked the same way: compare " +
                "its SHA-256."}
          </span>
        </p>
      </div>
    </details>
  );
}
