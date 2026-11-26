/**
 * "Connect your plans", in a dialog: the one flow, for the plans a door
 * picked (a card's Connect or Fix on Your AI, the address
 * `/accounts?connect=<plan or provider>`, the welcome's step). Where they
 * run is asked only when a plan runs through an app on a computer and the
 * person has none that can: in the cloud, made in a click, or on this
 * computer (`OFFER_THIS_COMPUTER`: the computers' own connect dialog). Then
 * one checklist (connect-lines.ts): the computer readied
 * (`computer.prepare`: woken, updated, asked), then one line per plan, one at
 * a time: its CLI installed as part of its sign-in, signed in (a link and a
 * code field; on the server, the account's own dialog: `accounts.connect`),
 * and a short test answered on it (`llm.test`), on the model the app's
 * listing names for the plan once it shows it connected: by then, the
 * models the plan said it runs as it signed in are kept. Every failure ends
 * in Try again, or a cloud computer for a laptop that's off; a command shows
 * only when an installer failed or can't run (Windows), with what it said,
 * and the computer's terminal a click away. Closing it stops a sign-in under
 * way; what's done stays.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  CopyButton,
  Dialog,
  Field,
  Icon,
  Input,
  LazyView,
  message,
  Notice,
  sayText,
  Spinner,
} from "../../../../../hosts/web/mod.ts";
import type { Account } from "../../../../access/accounts/contract.ts";
import type { Prepared } from "../../actions/prepare.ts";
import type { Computer } from "../../collections/computer.ts";
import { INSTALL } from "../../shared/install.ts";
import { ConnectDialog } from "./connect.tsx";
import {
  connected,
  type Facts,
  type Failure,
  finished,
  type Line,
  linesOf,
  nextOf,
  type Progress,
  retry,
} from "./connect-lines.ts";
import type { Kind } from "./kinds.ts";
import {
  bestComputer,
  cliOf,
  listed,
  type Machine,
  plainOutput,
  type PlanShown,
  safeLink,
  shownCode,
  signingIn,
  type Way,
  waysFor,
} from "./plan-states.ts";
import { visitorSystem } from "./platform.ts";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/**
 * Whether "On this computer" is offered where the plans run: it needs one
 * line in the person's terminal, once (the program isn't signed yet).
 */
export const OFFER_THIS_COMPUTER = true;

/** What a failed call says: its code, and its words. */
const failureOf = (error: unknown): Failure => ({
  ...((error as { code?: string })?.code ? { code: (error as { code: string }).code } : {}),
  message: message(error),
});

/** The connect flow, open: see the module's doc. */
export function ConnectFlow(
  { plans, picked, machines, computers, accounts, kinds, personal, onClose, call }: {
    plans: PlanShown[];
    /** The plans, or ways in (providers), to connect, in order. */
    picked: string[];
    machines: Machine[];
    computers: Computer[];
    accounts: Account[];
    kinds: Kind[];
    /** The person's Personal space: a computer made or connected here goes there. */
    personal?: string;
    onClose(): void;
    call: Call;
  },
): ReactNode {
  const [ways] = useState(() => waysFor(plans, picked));
  const [facts, setFacts] = useState<Facts>({ plans: {} });
  const [making, setMaking] = useState<{ busy?: boolean; error?: string }>({});
  const [local, setLocal] = useState(false);
  /** A laptop that's off, when the person chose a cloud computer instead: not picked again. */
  const [skipped, setSkipped] = useState<string>();
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  const sessions = useRef(new Map<string, ReturnType<typeof signingIn>>());
  const update = setFacts;

  const machine = machines.find((m) => m.computer._id === facts.computer);
  const os = (machine?.computer.info as { os?: string } | undefined)?.os;
  const lines = linesOf(ways, { ...facts, ...(os ? { os } : {}) }, accounts);

  // The computer: the person's best; with none, where to make one, used as soon as it's there.
  const needs = ways.some((w) => w.engine) && !facts.computer;
  const best = needs ? bestComputer(machines.filter((m) => m.computer._id !== skipped)) : undefined;
  useEffect(() => {
    if (best) update((f) => ({ ...f, computer: best.computer._id, kept: !!best.kind }));
  }, [best?.computer._id]);

  // A plan as the app lists it now (live). Its test waits until that shows it connected: listed
  // since its sign-in, its model is one the plan said it runs.
  const now = (way: Way) => plans.flatMap((p) => p.ways).find((w) => w.provider === way.provider);
  // The calls the lines need now.
  const next = nextOf(lines, facts).filter((n) =>
    n.call !== "test" || now(n.way)?.connected !== false
  );
  useEffect(() => {
    for (const n of next) {
      if (n.call === "prepare") {
        update((f) => ({ ...f, preparing: true }));
        void call<Prepared>("computer.prepare", { computer: n.computer }).then(
          (prepared) => update((f) => ({ ...f, preparing: false, prepared })),
          (error) => update((f) => ({ ...f, preparing: false, unprepared: failureOf(error) })),
        );
      } else if (n.call === "test") {
        const set = progress(n.way.provider);
        set({ test: "running" });
        void call<{ text: string }>("llm.test", { model: now(n.way)?.model ?? n.way.model }).then(
          ({ text }) => set({ test: "done", answer: text }),
          (error) => set({ test: "failed", failure: failureOf(error) }),
        );
      } else signIn(n.way, n.computer, n.install);
    }
  }, [next.map((n) => `${n.call}:${n.call === "prepare" ? n.computer : n.way.provider}`).join()]);

  /** Sets what a plan's progress says now, keeping the rest. */
  const progress = (provider: string) => (more: Progress) =>
    update((f) => ({ ...f, plans: { ...f.plans, [provider]: { ...f.plans[provider], ...more } } }));

  /** A plan's CLI signed in on the computer (installed first when asked), until it's done. */
  const signIn = (way: Way, computer: string, install: boolean) => {
    const set = progress(way.provider);
    set({ signin: "running", installing: install });
    setOutputs((o) => ({ ...o, [way.provider]: "" }));
    sessions.current.get(way.provider)?.leave();
    sessions.current.set(
      way.provider,
      signingIn({
        call,
        computer,
        engine: way.engine!,
        install,
        on: (event) => {
          if ("error" in event) return set({ signin: "failed", failure: failureOf(event.error) });
          const { step } = event;
          if (step.output) {
            setOutputs((o) => ({ ...o, [way.provider]: (o[way.provider] ?? "") + step.output }));
          }
          if (step.state === "running") return set(step.url ? { url: step.url } : {});
          set({
            signin: step.signedIn ? "done" : "failed",
            ...(step.installed !== undefined ? { installed: step.installed } : {}),
          });
        },
      }),
    );
  };
  // Closed while one runs, it stops there.
  useEffect(() => () => sessions.current.forEach((s) => s.stop()), []);

  const make = async (kind: Kind) => {
    setMaking({ busy: true });
    try {
      const { computer } = await call<{ computer: string }>(kind.add!.quick!.action, {
        ...kind.add!.quick!.input,
        ...(personal ? { in: personal } : {}),
      });
      update((f) => ({ ...f, computer, kept: true }));
      setMaking({});
    } catch (error) {
      setMaking({ error: message(error) });
    }
  };

  const where = needs && !best;
  const over = finished(lines);
  const done = connected(lines);
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      isolated
      title={where ? say("flowWhere") : say("flowTitle")}
      description={where
        ? say("flowWhereAbout", {
          plans: listed(ways.filter((w) => w.engine).map((w) => sayText(w.title))),
        })
        : undefined}
      footer={
        <Button variant={over ? "primary" : undefined} onClick={onClose}>
          {over ? say("done") : say("close")}
        </Button>
      }
    >
      {where
        ? (
          <Where
            kinds={kinds}
            making={making}
            make={(kind) => void make(kind)}
            local={() => setLocal(true)}
          />
        )
        : (
          <div className="flow">
            {over && done.length === ways.length
              ? (
                <p className="flow-over" role="status">
                  {say("flowDone", { plans: listed(done.map((w) => sayText(w.plan))) })}
                </p>
              )
              : null}
            <ol className="flow-lines">
              {lines.map((line) => (
                <LineShown
                  key={line.key}
                  line={line}
                  machine={machine}
                  progress={line.way ? facts.plans[line.way.provider] ?? {} : {}}
                  output={line.way ? outputs[line.way.provider] ?? "" : ""}
                  send={(text) => line.way && sessions.current.get(line.way.provider)?.send(text)}
                  retry={() => update((f) => retry(f, line))}
                  cloud={() => {
                    setSkipped(facts.computer);
                    update((f) => ({ plans: f.plans }));
                  }}
                />
              ))}
            </ol>
          </div>
        )}
      {local
        ? (
          <ConnectDialog
            open
            onClose={() => setLocal(false)}
            call={call}
            computers={computers}
            {...(personal ? { here: personal } : {})}
          />
        )
        : null}
    </Dialog>
  );
}

/** Where the plans run, for a person with no computer that can: in the cloud, or this one. */
function Where(
  { kinds, making, make, local }: {
    kinds: Kind[];
    making: { busy?: boolean; error?: string };
    make(kind: Kind): void;
    local(): void;
  },
): ReactNode {
  const cloud = kinds.find((k) => k.add?.quick);
  const here = OFFER_THIS_COMPUTER && !!visitorSystem();
  if (!cloud && !here) return <Notice tone="neutral" icon="computer">{say("whereNone")}</Notice>;
  return (
    <div className="flow-where">
      {cloud
        ? (
          <Card
            as="button"
            interactive={!cloud.blocked}
            padding="none"
            className="add-choice flow-choice"
            disabled={!!cloud.blocked || making.busy}
            onClick={() => make(cloud)}
          >
            <span className="add-choice-icon" data-kind={cloud.key}>
              {making.busy
                ? <Spinner size={18} />
                : <Icon name={cloud.icon ?? "server"} size={20} />}
            </span>
            <span className="add-choice-text">
              <span className="add-choice-title">
                {say("whereCloud")} <Badge tone="info">{say("recommended")}</Badge>
              </span>
              <span className="add-choice-description">
                {making.busy ? say("making") : cloud.blocked ?? say("whereCloudAbout")}
              </span>
              <LazyView kind="computer.cost" item={{}} hints={{ mode: "price" }} fallback={null} />
            </span>
          </Card>
        )
        : null}
      {here ? <ThisComputer pick={local} /> : null}
      {making.error
        ? (
          <Notice
            tone="destructive"
            role="alert"
            action={
              <Button size="sm" onClick={() => cloud && make(cloud)}>{say("tryAgain")}</Button>
            }
          >
            {say("makeFailed", { why: making.error })}
          </Notice>
        )
        : null}
    </div>
  );
}

/** "On this computer": free, while it's on; one line in its terminal, once. */
function ThisComputer({ pick }: { pick(): void }): ReactNode {
  return (
    <Card as="button" interactive padding="none" className="add-choice flow-choice" onClick={pick}>
      <span className="add-choice-icon">
        <Icon name="computer" size={20} />
      </span>
      <span className="add-choice-text">
        <span className="add-choice-title">{say("whereLocal")}</span>
        <span className="add-choice-description">{say("whereLocalAbout")}</span>
      </span>
    </Card>
  );
}

/** One line of the checklist: what it is, how it stands, and what to do when it needs the person. */
function LineShown(
  { line, machine, progress: p, output, send, retry, cloud }: {
    line: Line;
    machine?: Machine;
    progress: Progress;
    output: string;
    send(text: string): void;
    retry(): void;
    cloud(): void;
  },
): ReactNode {
  const { state, way, phase } = line;
  const computer = machine?.name ?? "";
  const cli = way?.engine ? cliOf(way.engine) : "";
  const plan = way ? sayText(way.title) : "";
  const title = way
    ? plan
    : state === "done"
    ? say("lineComputer", { computer })
    : machine && !machine.computer.online && machine.kind
    ? say("lineWaking", { computer })
    : say("lineGetting", { computer });
  const said = state === "done"
    ? line.limit
      ? say("lineLimit", { plan })
      : p.answer
      ? say("lineAnswered", { text: p.answer })
      : ""
    : state === "active" && phase === "installing"
    ? say("lineInstalling", { cli, computer })
    : state === "active" && phase === "testing"
    ? say("lineTesting")
    : "";
  return (
    <li className="flow-line" data-state={state}>
      <span className="flow-line-mark" aria-hidden="true">
        {state === "done"
          ? <Icon name="check" size={14} />
          : state === "failed"
          ? <Icon name="alert" size={14} />
          : state === "active"
          ? <Spinner size={14} />
          : null}
      </span>
      <div className="flow-line-body">
        <p className="flow-line-title">{title}</p>
        {said ? <p className="plan-quiet">{said}</p> : null}
        {state === "active" && phase === "signin" && way?.account
          ? <LazyView kind="accounts.connect" item={{ provider: way.account }} />
          : null}
        {state === "active" && phase === "signin" && way?.engine
          ? <CliSignIn cli={cli} url={p.url} output={output} send={send} />
          : null}
        {state === "failed"
          ? (
            <Failed
              line={line}
              computer={computer}
              cli={cli}
              plan={plan}
              output={output}
              retry={retry}
              cloud={cloud}
              {...(machine
                ? { href: `/computer/${encodeURIComponent(machine.computer._id)}` }
                : {})}
            />
          )
          : null}
      </div>
    </li>
  );
}

/** What a failed line says, with Try again; a cloud computer, or its command, when those fix it. */
function Failed(
  { line, computer, cli, plan, output, retry, cloud, href }: {
    line: Line;
    computer: string;
    cli: string;
    plan: string;
    output: string;
    retry(): void;
    cloud(): void;
    href?: string;
  },
): ReactNode {
  const why = line.failure?.message ?? "";
  const text = !line.way
    ? why
    : line.phase === "installing"
    ? line.failure || output
      ? say("failInstall", { cli, computer })
      : say("failWindows", { cli, computer })
    : line.phase === "signin"
    ? `${say("failSignIn", { plan })}${why ? ` ${why}` : ""}`
    : say("failTest", { plan, why });
  const command = line.way?.engine ? INSTALL[line.way.engine] : "";
  const shown = plainOutput(output).trim();
  return (
    <div className="flow-failed">
      <Notice
        tone="warning"
        role="alert"
        action={line.fix === "terminal" ? undefined : (
          <>
            <Button size="sm" onClick={retry}>{say("tryAgain")}</Button>
            {line.fix === "cloud"
              ? <Button size="sm" onClick={cloud}>{say("useCloud")}</Button>
              : null}
          </>
        )}
      >
        {text}
      </Notice>
      {shown && line.way
        ? (
          <CodeBlock
            className="plan-output-code"
            label={say("output", { cli })}
            code={shown}
            height={8}
            follow
          />
        )
        : null}
      {line.fix === "terminal"
        ? (
          <div className="plan-install">
            {line.failure || output ? <p>{say("orInstall", { computer })}</p> : null}
            <CodeBlock
              className="plan-install-command"
              label={say("installCommand", { cli })}
              code={[{ text: "$ ", tone: "muted" }, { text: command }]}
              copy={command}
            />
            <div className="plan-install-then">
              {href
                ? (
                  <Button size="sm" icon="terminal" href={href} target="_blank" rel="noopener">
                    {say("openTerminal", { computer })}
                  </Button>
                )
                : null}
              <Button size="sm" icon="refresh" onClick={retry}>{say("checkAgain")}</Button>
            </div>
          </div>
        )
        : null}
    </div>
  );
}

/** A CLI's sign-in under way: the sign-in page, the code it shows to type there, or a field for one it gives. */
function CliSignIn(
  { cli, url, output, send }: {
    cli: string;
    url?: string;
    output: string;
    send(text: string): void;
  },
): ReactNode {
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const link = safeLink(url);
  const shown = shownCode(plainOutput(output));
  if (!link) return <p className="plan-quiet">{say("stepSignInWait", { cli })}</p>;
  return (
    <div className="flow-signin">
      <p>{shown ? say("stepEnterCode") : say("stepSignInHere")}</p>
      {shown
        ? (
          <div className="plan-shown-code">
            <code>{shown}</code>
            <CopyButton text={shown} label={say("copyCode")} />
          </div>
        )
        : null}
      <Button
        variant="primary"
        iconEnd="external"
        href={link}
        target="_blank"
        rel="noopener noreferrer"
        className="plan-open"
      >
        {say("openSignIn")}
      </Button>
      {shown ? null : (
        <form
          className="plan-code"
          onSubmit={(event) => {
            event.preventDefault();
            if (!code.trim()) return;
            send(code.trim());
            setSent(true);
          }}
        >
          <Field label={say("codeLabel")} hint={sent ? say("codeSent") : say("codeHint")}>
            {(control) => (
              <Input
                {...control}
                value={code}
                placeholder={say("codePlaceholder")}
                spellCheck={false}
                autoComplete="one-time-code"
                autoCapitalize="off"
                onChange={(event) => {
                  setCode(event.currentTarget.value);
                  setSent(false);
                }}
                end={
                  <Button
                    type="submit"
                    size="sm"
                    variant={code.trim() && !sent ? "primary" : "ghost"}
                    disabled={!code.trim() || sent}
                  >
                    {say("send")}
                  </Button>
                }
              />
            )}
          </Field>
        </form>
      )}
    </div>
  );
}
