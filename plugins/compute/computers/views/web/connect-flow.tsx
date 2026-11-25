/**
 * "Connect your plans", in a dialog: the one flow, from Your AI (a card's
 * Connect or Fix, or the section's button), from an address
 * (`/accounts?connect=claude-plan`: a fix-it link) and from the welcome's
 * step. Which plans (skipped when the door said), where they run (only when
 * a plan runs through an app on a computer and the person has none that
 * can: in the cloud, made in a click, or on this computer), then one
 * checklist for everything picked, each line ticking itself off
 * (connect-lines.ts): the computer readied (`computer.prepare`: woken,
 * updated, asked), each missing CLI installed as part of its sign-in, each
 * sign-in in turn (a link and a code field; on the server, the account's own
 * steps: the `accounts.connect` View), and a test answered on each plan
 * (`llm.test`). Every failure ends in a button that fixes it, or a plain
 * sentence; a command shows only when an installer couldn't run, with what
 * it said, and the computer's terminal a click away. Closing it stops a
 * sign-in under way; what's done stays.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Checkbox,
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
import { useConnect } from "./connect.tsx";
import {
  connected,
  type Facts,
  type Failure,
  finished,
  forget,
  type Line,
  linesOf,
  nextOf,
} from "./connect-lines.ts";
import type { Kind } from "./kinds.ts";
import { SharedDialog } from "./plan-shared.tsx";
import {
  asksForCode,
  bestComputer,
  cardOf,
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

type Step = "pick" | "where" | "local" | "list";

/** The connect flow, open: see the module's doc. Closing it stops a sign-in under way. */
export function ConnectFlow(
  { plans, picked, on, machines, computers, accounts, kinds, personal, onClose, call }: {
    plans: PlanShown[];
    /** Plans, or ways in (providers), the door asked for: no choosing then. */
    picked?: string[];
    /** The computer to set them up on (Your computers' "Sign in to your plans here"). */
    on?: string;
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
  const [picks, setPicks] = useState<string[]>(() => picked ?? []);
  const [ways, setWays] = useState<Way[]>(() => picked?.length ? waysFor(plans, picked) : []);
  const [step, setStep] = useState<Step>(() => picked?.length ? "list" : "pick");
  const [facts, setFacts] = useState<Facts>({ signins: {}, tests: {} });
  const [making, setMaking] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const [fixing, setFixing] = useState<string>();
  const before = useRef(new Set(computers.map((c) => c._id)));
  const sessions = useRef(new Map<string, ReturnType<typeof signingIn>>());
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  const update = (change: (facts: Facts) => Facts) => setFacts((now) => change(now));

  const machine = machines.find((m) => m.computer._id === facts.computer);
  const lines = step === "list"
    ? linesOf(ways, {
      ...facts,
      ...(machine?.computer.info ? { os: (machine.computer.info as { os?: string }).os } : {}),
    }, accounts)
    : [];

  // The computer, once ways that need one are picked: theirs, or where to make one.
  useEffect(() => {
    if (step !== "list" || facts.computer || !ways.some((w) => w.engine)) return;
    const best = bestComputer(machines, on);
    if (best) update((f) => ({ ...f, computer: best.computer._id, kept: !!best.kind }));
    else setStep("where");
  }, [step, ways]);

  // This computer, connected: the flow goes on there.
  const arrived = step === "local"
    ? computers.find((c) => !before.current.has(c._id) && c.online)
    : undefined;
  useEffect(() => {
    if (!arrived) return;
    update((f) => ({ ...f, computer: arrived._id, kept: false }));
    setStep("list");
  }, [arrived?._id]);
  const local = useConnect({
    open: step === "local",
    onClose: () => setStep("where"),
    call,
    computers,
    ...(personal ? { here: personal } : {}),
    back: () => setStep("where"),
  });

  // The sign-in the person is on stays theirs until it's done.
  const going = lines.find((l) => l.kind === "signin" && l.state.is === "active")?.way?.provider;
  useEffect(() => {
    if (going !== facts.attending) update((f) => ({ ...f, attending: going }));
  }, [going]);

  // The calls the lines need now.
  const pending = nextOf(lines, facts).map((n) =>
    `${n.call}:${n.call === "prepare" ? n.computer : n.way.provider}`
  );
  useEffect(() => {
    for (const next of nextOf(lines, facts)) {
      if (next.call === "prepare") {
        update((f) => ({ ...f, preparing: true, unprepared: undefined }));
        void call<Prepared>("computer.prepare", { computer: next.computer }).then(
          (prepared) => update((f) => ({ ...f, preparing: false, prepared })),
          (error) => update((f) => ({ ...f, preparing: false, unprepared: failureOf(error) })),
        );
      } else if (next.call === "test") {
        const provider = next.way.provider;
        update((f) => ({ ...f, tests: { ...f.tests, [provider]: { is: "running" } } }));
        void call<{ text: string }>("llm.test", { model: next.way.model }).then(
          ({ text }) =>
            update((f) => ({ ...f, tests: { ...f.tests, [provider]: { is: "done", text } } })),
          (error) =>
            update((f) => ({
              ...f,
              tests: { ...f.tests, [provider]: { is: "failed", failure: failureOf(error) } },
            })),
        );
      } else signIn(next.way, next.computer, next.install);
    }
  }, [pending.join()]);

  /** A way's CLI signed in on the computer, asked again until it's done. */
  const signIn = (way: Way, computer: string, install: boolean) => {
    const provider = way.provider;
    const set = (signin: Facts["signins"][string]) =>
      update((f) => ({ ...f, signins: { ...f.signins, [provider]: signin } }));
    set({ is: "running", installing: install });
    setOutputs((o) => ({ ...o, [provider]: "" }));
    sessions.current.get(provider)?.leave();
    sessions.current.set(
      provider,
      signingIn({
        call,
        computer,
        engine: way.engine!,
        install,
        on: (event) => {
          if ("error" in event) return set({ is: "failed", failure: failureOf(event.error) });
          const { step } = event;
          if (step.output) {
            setOutputs((o) => ({ ...o, [provider]: (o[provider] ?? "") + step.output }));
          }
          if (step.state === "running") {
            return set({
              is: "running",
              installing: install,
              ...(step.url ? { url: step.url } : {}),
            });
          }
          set(
            step.signedIn ? { is: "done" } : {
              is: "failed",
              ...(step.installed !== undefined ? { installed: step.installed } : {}),
            },
          );
        },
      }),
    );
  };
  // Closed while one runs, it stops there.
  useEffect(() => () => sessions.current.forEach((s) => s.stop()), []);

  const fix = (line: Line) => {
    if (line.state.is !== "failed") return;
    if (line.state.fix === "cloud") {
      update((f) => ({ signins: f.signins, tests: f.tests }));
      setStep("where");
    } else if (line.state.fix === "shared") setFixing(facts.computer);
    else update((f) => forget(f, line));
  };

  const make = async (kind: Kind) => {
    const quick = kind.add?.quick;
    if (!quick) return;
    setMaking({ busy: true });
    try {
      const { computer } = await call<{ computer: string }>(quick.action, {
        ...quick.input,
        ...(personal ? { in: personal } : {}),
      });
      update((f) => ({ ...f, computer, kept: true }));
      setMaking({ busy: false });
      setStep("list");
    } catch (error) {
      setMaking({ busy: false, error: message(error) });
    }
  };

  const over = step === "list" && finished(lines);
  const done = over ? connected(lines) : [];
  const fixingMachine = machines.find((m) => m.computer._id === fixing);
  const needing = ways.filter((w) => w.engine).map((w) => sayText(w.title));

  const footer = step === "local" ? local.footer : step === "pick"
    ? (
      <>
        <Button onClick={onClose}>{say("cancel")}</Button>
        <Button
          variant="primary"
          disabled={!picks.length}
          onClick={() => {
            setWays(waysFor(plans, picks));
            setStep("list");
          }}
        >
          {say("flowNext")}
        </Button>
      </>
    )
    : (
      <Button variant={over ? "primary" : undefined} onClick={onClose}>
        {over ? say("done") : say("close")}
      </Button>
    );

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      isolated
      title={step === "where"
        ? say("flowWhere")
        : step === "local"
        ? local.title
        : say("flowTitle")}
      description={step === "pick"
        ? say("flowPick")
        : step === "where"
        ? say("flowWhereAbout", { plans: listed(needing) })
        : step === "local"
        ? local.description
        : undefined}
      footer={footer}
    >
      {step === "pick"
        ? (
          <ul className="flow-picks">
            {plans.map((plan) => {
              const ready = cardOf(plan, machines, accounts).state === "ready";
              const checked = picks.includes(plan.plan);
              return (
                <li key={plan.plan}>
                  <Checkbox
                    className="flow-pick"
                    checked={checked}
                    onChange={() =>
                      setPicks(
                        checked ? picks.filter((p) => p !== plan.plan) : [...picks, plan.plan],
                      )}
                    label={
                      <span className="flow-pick-text">
                        <span>{sayText(plan.plan)}</span>
                        {ready ? <Badge tone="success">{say("flowConnected")}</Badge> : null}
                      </span>
                    }
                  />
                </li>
              );
            })}
          </ul>
        )
        : step === "where"
        ? (
          <Where
            kinds={kinds}
            making={making}
            make={(kind) => void make(kind)}
            local={() => {
              before.current = new Set(computers.map((c) => c._id));
              setStep("local");
            }}
          />
        )
        : step === "local"
        ? local.body
        : (
          <div className="flow">
            {over
              ? (
                <p className="flow-over" role="status">
                  {done.length
                    ? `${say("flowDone", { plans: listed(done.map((w) => sayText(w.plan))) })}${
                      done.length < ways.length ? ` ${say("flowLeft")}` : ""
                    }`
                    : say("flowNone")}
                </p>
              )
              : null}
            <ol className="flow-lines">
              {lines.map((line) => (
                <LineShown
                  key={line.key}
                  line={line}
                  machine={machine}
                  accounts={accounts}
                  facts={facts}
                  output={line.way ? outputs[line.way.provider] ?? "" : ""}
                  send={(text) => line.way && sessions.current.get(line.way.provider)?.send(text)}
                  fix={() => fix(line)}
                />
              ))}
            </ol>
          </div>
        )}
      {fixingMachine
        ? (
          <SharedDialog
            machine={fixingMachine}
            onClose={() => setFixing(undefined)}
            check={() => Promise.resolve(update((f) => ({ ...f, unprepared: undefined })))}
            call={call}
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
    making: { busy: boolean; error?: string };
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
              <LazyView
                kind="computer.cost"
                item={{}}
                hints={{ mode: "price", kind: cloud.key }}
                fallback={null}
              />
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
  { line, machine, accounts, facts, output, send, fix }: {
    line: Line;
    machine?: Machine;
    accounts: Account[];
    facts: Facts;
    output: string;
    send(text: string): void;
    fix(): void;
  },
): ReactNode {
  const { state, way } = line;
  const computer = machine?.name ?? "";
  const cli = way?.engine ? cliOf(way.engine) : "";
  const plan = way ? sayText(way.title) : "";
  const title = line.kind === "computer"
    ? state.is === "active"
      ? machine && !machine.computer.online && machine.kind
        ? say("lineWaking", { computer })
        : say("lineGetting", { computer })
      : say("lineComputer", { computer })
    : line.kind === "install"
    ? state.is === "active" ? say("lineInstalling", { cli, computer }) : say("lineInstall", { cli })
    : line.kind === "signin"
    ? say("lineSignIn", { plan })
    : say("lineTest", { plan });
  const signedAs = line.kind === "signin" && state.is === "done"
    ? way?.engine
      ? (facts.prepared?.engines[way.engine]?.account ??
        (machine?.computer.engines as Record<string, { account?: string }> | undefined)
          ?.[way.engine]
          ?.account)
      : accounts.find((a) => a.provider === way?.account)?.label
    : undefined;
  const test = way ? facts.tests[way.provider] : undefined;
  return (
    <li className="flow-line" data-state={state.is}>
      <span className="flow-line-mark" aria-hidden="true">
        {state.is === "done"
          ? <Icon name="check" size={14} />
          : state.is === "failed"
          ? <Icon name="alert" size={14} />
          : state.is === "active"
          ? <Spinner size={14} />
          : null}
      </span>
      <div className="flow-line-body">
        <p className="flow-line-title">{title}</p>
        {state.is === "done"
          ? (
            <p className="plan-quiet">
              {state.note === "old"
                ? say("lineOld", { computer })
                : state.note === "already"
                ? signedAs ? say("lineSignedInAs", { account: signedAs }) : say("lineAlready")
                : state.note === "limit"
                ? say("lineLimit", { plan })
                : state.note === "model"
                ? say("lineModel", { model: way?.model?.split("/").slice(1).join("/") ?? "" })
                : line.kind === "signin" && signedAs
                ? say("lineSignedInAs", { account: signedAs })
                : line.kind === "test" && test?.is === "done"
                ? say("lineAnswered", { text: test.text })
                : null}
            </p>
          )
          : null}
        {state.is === "active" && line.kind === "test"
          ? <p className="plan-quiet">{say("lineTesting")}</p>
          : null}
        {state.is === "active" && line.kind === "signin" && way?.account
          ? (
            <LazyView
              kind="accounts.connect"
              item={{ provider: way.account }}
              hints={{ again: accounts.some((a) => a.provider === way.account) }}
            />
          )
          : null}
        {state.is === "active" && line.kind === "signin" && way?.engine
          ? (
            <CliSignIn
              cli={cli}
              computer={computer}
              cloud={!!machine?.kind}
              signin={facts.signins[way.provider]}
              output={output}
              send={send}
            />
          )
          : null}
        {state.is === "failed"
          ? (
            <Failed
              line={line}
              computer={computer}
              cli={cli}
              plan={plan}
              cloud={!!machine?.kind}
              output={output}
              fix={fix}
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

/** What a failed line says, and the one button that fixes it (or its command, as a fallback). */
function Failed(
  { line, computer, cli, plan, cloud, output, fix, href }: {
    line: Line;
    computer: string;
    cli: string;
    plan: string;
    cloud: boolean;
    output: string;
    fix(): void;
    href?: string;
  },
): ReactNode {
  if (line.state.is !== "failed") return null;
  const { why, fix: how, failure, old } = line.state;
  const text = {
    off: say("failOff", { computer }),
    wake: failure?.message ?? "",
    shared: say("failShared", { computer }),
    reach: say("failReach", { computer, why: failure?.message ?? "" }),
    install: say("failInstall", { cli, computer }),
    windows: say("failWindows", { cli, computer }),
    signin: say("failSignIn", { plan }),
    gone: say("failGone", { computer }),
    signedOut: say("failSignedOut", { plan }),
    test: say("failTest", { plan, why: failure?.message ?? "" }),
  }[why];
  const command = line.way?.engine ? INSTALL[line.way.engine] : "";
  const shown = plainOutput(output).trim();
  return (
    <div className="flow-failed">
      <Notice
        tone="warning"
        role="alert"
        action={how === "terminal" ? undefined : (
          <Button size="sm" onClick={fix}>
            {how === "cloud"
              ? say("useCloud")
              : how === "shared"
              ? say("howToFix")
              : how === "signin"
              ? say("signInAgain")
              : say("tryAgain")}
          </Button>
        )}
      >
        {text}
        {old
          ? ` ${cloud ? say("failOldCloud", { computer }) : say("failOldLaptop", { computer })}`
          : ""}
      </Notice>
      {shown && (why === "install" || why === "signin")
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
      {how === "terminal"
        ? (
          <div className="plan-install">
            {why === "install" ? <p>{say("orInstall", { computer })}</p> : null}
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
              <Button size="sm" icon="refresh" onClick={fix}>{say("checkAgain")}</Button>
            </div>
          </div>
        )
        : null}
    </div>
  );
}

/** A CLI's sign-in under way: the sign-in page (a link here, or there), a code to type or paste. */
function CliSignIn(
  { cli, computer, cloud, signin, output, send }: {
    cli: string;
    computer: string;
    cloud: boolean;
    signin?: Facts["signins"][string];
    output: string;
    send(text: string): void;
  },
): ReactNode {
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [askCode, setAskCode] = useState(false);
  const plain = plainOutput(output);
  const link = safeLink(signin?.is === "running" ? signin.url : undefined);
  const shown = shownCode(plain);
  const codeField = askCode || (!!link && !shown && (cloud || asksForCode(plain)));
  const submit = () => {
    const typed = code.trim();
    if (!typed) return;
    send(typed);
    setSent(true);
  };
  return (
    <div className="flow-signin">
      {link && (cloud || shown)
        ? (
          <>
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
              onClick={() => setAskCode(!shown)}
            >
              {say("openSignIn")}
            </Button>
          </>
        )
        : link
        ? (
          <>
            <p>{say("stepSignInThere", { computer })}</p>
            <Button
              variant="link"
              size="sm"
              iconEnd="external"
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="plan-open"
            >
              {say("notOpened")}
            </Button>
          </>
        )
        : signin?.is === "running" && !signin.installing
        ? <p className="plan-quiet">{say("stepSignInWait", { cli })}</p>
        : null}
      {codeField
        ? (
          <form
            className="plan-code"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
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
        )
        : link && !shown
        ? (
          <Button variant="link" size="sm" className="plan-open" onClick={() => setAskCode(true)}>
            {say("gotCode")}
          </Button>
        )
        : null}
    </div>
  );
}
