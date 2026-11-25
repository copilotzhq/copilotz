/**
 * Signing a plan in, in a dialog: on which computer (the best one first: on,
 * not shared, its CLI there; straight to it when it's the only one, or a
 * computer's own Sign in was pressed), what that one still needs (its CLI
 * installed, to be on), then the CLI's own sign-in there. A missing CLI is
 * installed first, on macOS and Linux, when the person presses "Install
 * {cli} and sign in" (it says what it runs there); an installer that fails
 * shows what it said last and how to install it by hand, as Windows always
 * does. The sign-in
 * (`computer.engine.login`, asked again every second while it runs):
 * starting it, the sign-in page (on a laptop the CLI opens it there itself;
 * on a cloud computer, a link here), a code to paste back when it asks for
 * one (or the one it shows, to type on the page), what the CLI says, and
 * done (as whom) or why not. Closing it while it runs stops it there.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Button,
  CodeBlock,
  CopyButton,
  Dialog,
  Field,
  Icon,
  Input,
  message,
  Notice,
  Radio,
  Spinner,
} from "../../../../../hosts/web/mod.ts";
import type { IconName } from "../../../../../hosts/web/mod.ts";
import { ComputerMark } from "./mark.tsx";
import { Install } from "./plan-card.tsx";
import {
  asksForCode,
  installable,
  listed,
  type Machine,
  plainOutput,
  type Plan,
  ranked,
  reachable,
  safeLink,
  shownCode,
  signingIn,
  standingOf,
  startable,
  straightTo,
} from "./plan-states.ts";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;
type Phase = "choose" | "running" | "done" | "failed";

export function SignInDialog(
  { plan, machines, picked, open, onClose, check, call }: {
    plan: Plan;
    machines: Machine[];
    /** The computer it's for, when one was picked (its own Sign in). */
    picked?: string;
    open: boolean;
    onClose(): void;
    /** Asks the computers again (after installing a CLI). */
    check(): Promise<void>;
    call: Call;
  },
): ReactNode {
  const order = ranked(machines, plan.engine);
  const [first] = useState(() => {
    const given = picked ? machines.find((m) => m.computer._id === picked) : undefined;
    const straight = given && startable(given, plan.engine)
      ? given
      : picked
      ? undefined
      : straightTo(machines, plan.engine);
    return { chosen: given ?? straight ?? order[0], straight };
  });
  const [chosen, setChosen] = useState(first.chosen?.computer._id);
  const [phase, setPhase] = useState<Phase>("choose");
  const [output, setOutput] = useState("");
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [askCode, setAskCode] = useState(false);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const session = useRef<ReturnType<typeof signingIn>>(undefined);
  const machine = machines.find((m) => m.computer._id === chosen);

  const start = (computer: string, install = false) => {
    session.current?.leave();
    setInstalling(install);
    setOutput("");
    setUrl(undefined);
    setError(undefined);
    setCode("");
    setSent(false);
    setAskCode(false);
    setPhase("running");
    session.current = signingIn({
      call,
      computer,
      engine: plan.engine,
      install,
      on: (event) => {
        if ("error" in event) {
          setError(message(event.error));
          setPhase("failed");
          return;
        }
        const { step } = event;
        if (step.output) setOutput((said) => said + step.output);
        if (step.url) setUrl(step.url);
        if (step.state === "done") setPhase(step.signedIn ? "done" : "failed");
      },
    });
  };
  // Straight in, when there's nothing to choose; stopped there if it's closed while it runs.
  useEffect(() => {
    if (open && first.straight) start(first.straight.computer._id);
    return () => session.current?.stop();
  }, []);

  const close = () => {
    session.current?.stop();
    onClose();
  };
  const recheck = async () => {
    setChecking(true);
    try {
      await check();
    } finally {
      setChecking(false);
    }
  };
  const send = () => {
    const typed = code.trim();
    if (!typed || !session.current) return;
    session.current.send(typed);
    setSent(true);
  };

  const plain = plainOutput(output);
  const link = safeLink(url);
  const cloud = !!machine?.kind;
  const shown = shownCode(plain);
  const codeField = askCode || (!!link && !shown && (cloud || asksForCode(plain)));
  const on = machine ? { cli: plan.cli, computer: machine.name } : undefined;
  // Its CLI missing there, Sign in installs it first (not on Windows).
  const install = !!machine && installable(machine, plan.engine);
  const can = !!machine && (startable(machine, plan.engine) || install);
  const missing = !!machine && standingOf(machine, plan.engine).state === "missing";
  const account = machine && phase === "done"
    ? (() => {
      const standing = standingOf(machine, plan.engine);
      return standing.state === "signedIn" ? standing.account : undefined;
    })()
    : undefined;

  const footer = phase === "done"
    ? <Button variant="primary" onClick={close}>{say("done")}</Button>
    : phase === "failed"
    ? (
      <>
        {machines.length > 1
          ? (
            <Button
              variant="ghost"
              icon="chevron-left"
              className="plan-back"
              onClick={() => setPhase("choose")}
            >
              {say("anotherComputer")}
            </Button>
          )
          : null}
        <Button onClick={close}>{say("close")}</Button>
        <Button
          variant="primary"
          icon="refresh"
          disabled={!can}
          onClick={() => machine && start(machine.computer._id, install)}
        >
          {say("tryAgain")}
        </Button>
      </>
    )
    : phase === "running"
    ? <Button onClick={close}>{say("cancel")}</Button>
    : (
      <>
        <Button onClick={close}>{say("cancel")}</Button>
        <Button
          variant="primary"
          disabled={!can}
          onClick={() => machine && start(machine.computer._id, install)}
        >
          {install ? say("installAndSignIn", { cli: plan.cli }) : say("start")}
        </Button>
      </>
    );

  return (
    <Dialog
      open={open}
      onClose={close}
      size={phase === "done" ? "sm" : "md"}
      title={phase === "done"
        ? say("doneTitle", { plan: plan.plan })
        : say("signInTitle", { plan: plan.plan })}
      description={phase === "done"
        ? undefined
        : phase === "choose" || !on
        ? say("signInThrough", { cli: plan.cli })
        : say("signInOn", on)}
      footer={footer}
    >
      {phase === "done" && machine
        ? (
          <div role="status">
            <div className="plan-done">
              <span className="plan-done-icon">
                <Icon name="check" size={22} />
              </span>
              <div>
                <p className="plan-done-title">
                  {account ? say("doneAs", { account }) : say("rowSignedIn")}
                </p>
                <p className="plan-done-on">{say("doneOn", on!)}</p>
              </div>
            </div>
            <p className="plan-done-next">{say("doneNext")}</p>
          </div>
        )
        : phase === "failed"
        ? (
          <div className="plan-signin">
            {missing && on && !error
              ? (
                <Notice tone="destructive" role="alert" title={say("installFailedTitle", on)}>
                  {say("installFailedText")}
                </Notice>
              )
              : (
                <Notice
                  tone="destructive"
                  role="alert"
                  title={say("failedTitle", { cli: plan.cli })}
                >
                  {error ? say("failedStart", { why: error }) : say("failedEnded")}
                </Notice>
              )}
            {plain.trim()
              ? (
                <CodeBlock
                  className="plan-output-code"
                  label={say("output", { cli: plan.cli })}
                  code={plain.trim()}
                  height={8}
                  follow
                />
              )
              : null}
            {missing && machine
              ? (
                <Install
                  plan={plan}
                  computer={machine.name}
                  lead={say("installMissing", on!)}
                  check={recheck}
                  checking={checking}
                />
              )
              : null}
          </div>
        )
        : phase === "running" && machine
        ? (
          <div className="plan-signin">
            <ol className="plan-steps">
              <Step
                n={1}
                state={link || (output && !installing) ? "done" : "active"}
                title={!machine.computer.online && machine.kind
                  ? say("stepWake", { computer: machine.name })
                  : installing
                  ? say("stepInstall", on!)
                  : say("stepStart", on!)}
              />
              <Step
                n={2}
                state={link ? "active" : "later"}
                title={say("stepSignIn", { plan: plan.plan })}
              >
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
                      <p>{say("stepSignInThere", { computer: machine.name })}</p>
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
                  : <p className="plan-quiet">{say("stepSignInWait", { cli: plan.cli })}</p>}
              </Step>
              {codeField
                ? (
                  <Step n={3} state={sent ? "done" : "active"} title={say("stepCode")}>
                    <form
                      className="plan-code"
                      onSubmit={(event) => {
                        event.preventDefault();
                        send();
                      }}
                    >
                      <Field label={say("codeLabel")} hint={say("codeHint")}>
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
                  </Step>
                )
                : link && !shown
                ? (
                  <li className="plan-step-more">
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => setAskCode(true)}
                    >
                      {say("gotCode")}
                    </Button>
                  </li>
                )
                : null}
            </ol>
            <p className="plan-waiting" role="status">
              <Spinner size={15} />
              <span>{sent ? say("codeSent") : say("waiting")}</span>
            </p>
            {plain.trim() ? <Output cli={plan.cli} text={plain.trim()} /> : null}
          </div>
        )
        : (
          <div className="plan-signin">
            {order.length > 1
              ? (
                <fieldset className="plan-choose">
                  <legend>{say("whichComputer")}</legend>
                  {order.map((m) => (
                    <Choice
                      key={m.computer._id}
                      plan={plan}
                      machine={m}
                      checked={m.computer._id === chosen}
                      pick={() => setChosen(m.computer._id)}
                    />
                  ))}
                  <p className="plan-quiet">{say("whichHint")}</p>
                </fieldset>
              )
              : null}
            {machine
              ? (
                <Needs
                  plan={plan}
                  machine={machine}
                  alone={order.length === 1}
                  check={recheck}
                  checking={checking}
                />
              )
              : (
                <Notice tone="neutral" icon="computer" title={say("noComputerTitle")}>
                  {say("noComputerText")}
                </Notice>
              )}
            <p className="plan-own">
              <Icon name="lock" size={13} />
              <span>{say("ownSignIn", { cli: plan.cli })}</span>
            </p>
          </div>
        )}
    </Dialog>
  );
}

/** One step of the sign-in: its number (a check once it's done), what it is, and what it shows. */
function Step(
  { n, state, title, children }: {
    n: number;
    state: "done" | "active" | "later";
    title: string;
    children?: ReactNode;
  },
): ReactNode {
  return (
    <li className="plan-step" data-state={state}>
      <span className="plan-step-number" aria-hidden="true">
        {state === "done"
          ? <Icon name="check" size={14} />
          : state === "active" && n === 1
          ? <Spinner size={14} />
          : n}
      </span>
      <div className="plan-step-body">
        <p className="plan-step-title">{title}</p>
        {children}
      </div>
    </li>
  );
}

/** A computer to sign in on, as a choice: on or not, and how it stands for the plan. */
function Choice(
  { plan, machine: m, checked, pick }: {
    plan: Plan;
    machine: Machine;
    checked: boolean;
    pick(): void;
  },
): ReactNode {
  const standing = standingOf(m, plan.engine);
  const text = standing.state === "shared"
    ? say("rowSharedSomewhere")
    : !reachable(m)
    ? say("offline")
    : standing.state === "signedIn"
    ? standing.account ? say("rowSignedInAs", { account: standing.account }) : say("rowSignedIn")
    : standing.state === "missing"
    ? say("rowMissing", { cli: plan.cli })
    : !m.computer.online && m.kind
    ? say("optionAsleep")
    : say("optionReady");
  return (
    <Radio
      name={`plan-computer-${plan.engine}`}
      className="plan-choice"
      data-state={standing.state}
      checked={checked}
      disabled={standing.state === "shared"}
      onChange={pick}
      label={
        <span className="plan-choice-text">
          <ComputerMark
            online={m.computer.online}
            {...(m.kind?.icon ? { icon: m.kind.icon as IconName } : {})}
          />
          <span className="plan-choice-name">{m.name}</span>
          <span className="plan-choice-state">{text}</span>
        </span>
      }
    />
  );
}

/** What the computer chosen still needs before a sign-in starts there, if anything. */
function Needs(
  { plan, machine: m, alone, check, checking }: {
    plan: Plan;
    machine: Machine;
    /** It's the person's only computer: its name isn't shown above. */
    alone: boolean;
    check(): Promise<void>;
    checking: boolean;
  },
): ReactNode {
  const standing = standingOf(m, plan.engine);
  const named = alone
    ? (
      <div className="plan-alone">
        <ComputerMark
          online={m.computer.online}
          {...(m.kind?.icon ? { icon: m.kind.icon as IconName } : {})}
        />
        <span>{m.name}</span>
      </div>
    )
    : null;
  if (standing.state === "shared") {
    const spaces = Array.isArray(m.shared) ? m.shared.map((s) => s.name) : [];
    return (
      <>
        {named}
        <Notice tone="warning" icon="users" title={say("sharedTitle", { computer: m.name })}>
          {spaces.length
            ? `${say("sharedWhy", { spaces: listed(spaces), computer: m.name })} ${
              say("sharedFix", { spaces: listed(spaces) })
            }`
            : say("sharedWhySomewhere", { computer: m.name })}
        </Notice>
      </>
    );
  }
  if (!reachable(m)) {
    return (
      <>
        {named}
        <Notice tone="warning" icon="computer">
          {say("offlineNote", { computer: m.name })}
        </Notice>
      </>
    );
  }
  if (standing.state === "missing" && installable(m, plan.engine)) {
    return (
      <>
        {named}
        <div className="plan-install">
          <p>{say("installRuns", { cli: plan.cli, computer: m.name })}</p>
          <CodeBlock
            className="plan-install-command"
            label={say("installCommand", { cli: plan.cli })}
            code={[{ text: "$ ", tone: "muted" }, { text: plan.install }]}
            copy={plan.install}
          />
        </div>
      </>
    );
  }
  if (standing.state === "missing") {
    return (
      <>
        {named}
        <Install
          plan={plan}
          computer={m.name}
          lead={say("installMissing", { cli: plan.cli, computer: m.name })}
          check={check}
          checking={checking}
        />
      </>
    );
  }
  return (
    <>
      {named}
      {!m.computer.online
        ? <p className="plan-quiet">{say("wakeNote", { computer: m.name })}</p>
        : standing.state === "unchecked"
        ? <p className="plan-quiet">{say("rowOld")}</p>
        : null}
    </>
  );
}

/** What the CLI says, folded under its last line. */
function Output({ cli, text }: { cli: string; text: string }): ReactNode {
  const lastLine = text.split("\n").filter((l) => l.trim()).at(-1) ?? "";
  return (
    <details className="plan-output">
      <summary>
        <Icon name="chevron" size={14} className="plan-output-chevron" />
        <span className="plan-output-what">{say("output", { cli })}</span>
        <span className="plan-output-last">{lastLine}</span>
      </summary>
      <CodeBlock
        className="plan-output-code"
        label={say("output", { cli })}
        code={text}
        height={8}
        follow
      />
    </details>
  );
}
