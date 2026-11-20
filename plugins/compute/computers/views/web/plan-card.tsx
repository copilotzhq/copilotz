/**
 * One plan on Connected accounts: what it does, whether it's signed in, and
 * each computer of the person's as it stands for it: signed in (as whom, its
 * CLI's version), installed but not signed in, its CLI missing (its official
 * install, on a tap), not checked yet, or shared with others' agents (why
 * it can't be used, on a tap). Offline, a computer says when it last said
 * so; a cloud computer says its state its kind's way. The one thing to do
 * comes first: Sign in, until it is.
 */
import { type ReactNode, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  Icon,
  LazyView,
  Menu,
  Time,
} from "../../../../../hosts/web/mod.ts";
import type { IconName } from "../../../../../hosts/web/mod.ts";
import { ComputerMark } from "./mark.tsx";
import {
  isShared,
  listed,
  type Machine,
  type Plan,
  ranked,
  reachable,
  signedOn,
  type Standing,
  standingOf,
  startable,
  straightTo,
} from "./plans.ts";
import { say } from "./words.ts";

export function PlanCard(
  { plan, machines, check, checking, signIn }: {
    plan: Plan;
    machines: Machine[];
    /** Asks the computers again. */
    check(): Promise<void>;
    checking: boolean;
    /** Opens the sign-in: on this computer, or the one it picks. */
    signIn(computer?: string): void;
  },
): ReactNode {
  const on = signedOn(machines, plan.engine);
  const signed = on.length > 0;
  // Signed in, but on no computer that's there now: until one is, agents use the app's models.
  const away = signed && !on.some(reachable);
  // Somewhere else to sign in: a computer that can start one, not signed in yet.
  const elsewhere = machines.some((m) =>
    startable(m, plan.engine) && standingOf(m, plan.engine).state !== "signedIn"
  );
  // Where the card's own Sign in goes at once: that computer's line doesn't offer it again.
  const straight = signed ? undefined : straightTo(machines, plan.engine);
  const titleId = `plan-${plan.engine}`;
  return (
    <Card as="li" padding="none" className="plan" aria-labelledby={titleId}>
      <div className="plan-head">
        <span className="plan-mark" aria-hidden="true">
          <Icon name="sparkles" size={20} />
        </span>
        <div className="plan-titles">
          <h3 className="plan-title" id={titleId}>
            {plan.title}
            {signed ? <Badge tone="success">{say("signedIn")}</Badge> : null}
          </h3>
          <p className="plan-about">{plan.about}</p>
        </div>
        <div className="plan-actions">
          {!signed
            ? (
              <Button variant="primary" onClick={() => signIn()}>
                {say("signIn")}
              </Button>
            )
            : elsewhere
            ? (
              <Button variant="ghost" size="sm" icon="plus" onClick={() => signIn()}>
                {say("signInOther")}
              </Button>
            )
            : null}
        </div>
      </div>
      <ul className="plan-computers">
        {ranked(machines.filter((m) => !isShared(m)), plan.engine).map((m) => (
          <Row
            key={m.computer._id}
            plan={plan}
            machine={m}
            check={check}
            checking={checking}
            signIn={() => signIn(m.computer._id)}
            offer={m !== straight}
          />
        ))}
      </ul>
      {away
        ? (
          <p className="plan-away">
            <Icon name="info" size={14} />
            <span>{say("runsWhileOn", { computer: listed(on.map((m) => m.name)) })}</span>
          </p>
        )
        : null}
    </Card>
  );
}

/** What a computer's line says of the plan there, with its glyph and tone. */
function said(
  plan: Plan,
  m: Machine,
  standing: Standing,
): { icon?: IconName; tone: string; text: string } {
  switch (standing.state) {
    case "shared":
      return { icon: "users", tone: "warning", text: say("rowSharedSomewhere") };
    case "signedIn":
      return {
        icon: "check-circle",
        tone: "success",
        text: standing.account
          ? say("rowSignedInAs", { account: standing.account })
          : say("rowSignedIn"),
      };
    case "installed":
      return { tone: "neutral", text: say("rowInstalled") };
    case "missing":
      return { tone: "muted", text: say("rowMissing", { cli: plan.cli }) };
    case "unchecked":
      return {
        tone: "muted",
        text: m.computer.online ? say("rowOld") : say("rowUnchecked"),
      };
  }
}

function Row(
  { plan, machine: m, check, checking, signIn, offer }: {
    plan: Plan;
    machine: Machine;
    check(): Promise<void>;
    checking: boolean;
    signIn(): void;
    /** Whether it offers its own Sign in (not when the card's goes straight to it). */
    offer: boolean;
  },
): ReactNode {
  const [installing, setInstalling] = useState(false);
  const standing = standingOf(m, plan.engine);
  const line = said(plan, m, standing);
  const at = "at" in standing ? standing.at : undefined;
  const version = "version" in standing ? standing.version : undefined;
  const can = startable(m, plan.engine);
  const action = standing.state === "missing"
    ? (
      <Button
        size="sm"
        variant="ghost"
        iconEnd={installing ? "chevron-down" : "chevron"}
        aria-expanded={installing}
        onClick={() => setInstalling(!installing)}
      >
        {installing ? say("hideInstall") : say("howToInstall")}
      </Button>
    )
    : standing.state === "installed" && can && offer
    ? <Button size="sm" onClick={signIn}>{say("signIn")}</Button>
    : standing.state === "signedIn" && can
    ? (
      <Menu
        label={say("moreOn", { computer: m.name })}
        items={[{ label: say("signInAgain"), icon: "refresh", onSelect: signIn }]}
      />
    )
    : null;
  return (
    <li className="plan-computer" data-state={standing.state}>
      <ComputerMark
        online={m.computer.online}
        {...(m.kind?.icon ? { icon: m.kind.icon as IconName } : {})}
      />
      <div className="plan-computer-text">
        <span className="plan-computer-name">{m.name}</span>
        <span className="plan-computer-state" data-tone={line.tone}>
          {line.icon ? <Icon name={line.icon} size={13} /> : null}
          <span>{line.text}</span>
          {version && standing.state === "signedIn"
            ? <span className="plan-computer-quiet">· {say("version", { version })}</span>
            : null}
          {m.kind
            ? (
              <span className="plan-computer-kind">
                <LazyView
                  kind={m.kind.view}
                  item={{ _id: m.computer._id }}
                  hints={{ mode: "badge" }}
                  fallback={null}
                />
              </span>
            )
            : !m.computer.online
            ? (
              <span className="plan-computer-quiet">
                · {say("offline")}
                {at ? <>{" · "}{say.nodes("checkedAt", { time: <Time at={at} /> })}</> : null}
              </span>
            )
            : null}
        </span>
      </div>
      {action ? <div className="plan-computer-action">{action}</div> : null}
      {installing && standing.state === "missing"
        ? <Install plan={plan} computer={m.name} check={check} checking={checking} />
        : null}
    </li>
  );
}

/** Installing a plan's CLI on a computer: its official command, then checking again. */
export function Install(
  { plan, computer, lead, check, checking }: {
    plan: Plan;
    /** The computer's name, when it's one in particular. */
    computer?: string;
    /** What it says first, in place of where to run it. */
    lead?: string;
    check(): Promise<void>;
    checking: boolean;
  },
): ReactNode {
  return (
    <div className="plan-install">
      <p>{lead ?? (computer ? say("installIn", { computer }) : say("installAnywhere"))}</p>
      <CodeBlock
        className="plan-install-command"
        label={say("installCommand", { cli: plan.cli })}
        code={[{ text: "$ ", tone: "muted" }, { text: plan.install }]}
        copy={plan.install}
      />
      <div className="plan-install-then">
        <span>{say("installThen", { cli: plan.cli })}</span>
        <Button size="sm" icon="refresh" loading={checking} onClick={() => void check()}>
          {say("checkAgain")}
        </Button>
      </div>
    </div>
  );
}
