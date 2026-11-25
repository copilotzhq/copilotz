/**
 * One plan on Your AI: its name, how it stands in a sentence (`cardOf`:
 * running on the server, or on a computer, with its backup; signed in only
 * on computers that are off; needing the person; not connected), its limit
 * when it's at it, a cloud computer's cost line (the `computer.cost` View),
 * and its one action: Connect, Fix (both open the connect flow), or, ready,
 * a menu to sign out of each place it's signed in, and its other ways in.
 */
import type { ReactNode } from "react";
import {
  Badge,
  Button,
  Card,
  Icon,
  LazyView,
  Menu,
  sayText,
  Time,
} from "../../../../../hosts/web/mod.ts";
import type { Account } from "../../../../access/accounts/contract.ts";
import {
  type Card as Standing,
  cardOf,
  cliOf,
  listed,
  type Machine,
  type PlanShown,
  servingOn,
  type Way,
} from "./plan-states.ts";
import { say } from "./words.ts";

/** A place it's signed in, to sign out of: a computer, or the server (an account). */
export type SignedIn = { way: Way; computer?: string; account?: string };

/** One plan's card: see the module's doc. */
export function PlanCard(
  { plan, machines, accounts, connect, signOut }: {
    plan: PlanShown;
    machines: Machine[];
    accounts: Account[];
    /** Opens the connect flow for this plan, or one of its ways. */
    connect(provider?: string): void;
    signOut(where: SignedIn): void;
  },
): ReactNode {
  const card = cardOf(plan, machines, accounts);
  const titleId = `plan-${plan.ways[0].provider}`;
  const places: SignedIn[] = plan.ways.flatMap((way): SignedIn[] =>
    way.engine
      ? servingOn(machines, way.engine).map((m) => ({ way, computer: m.computer._id }))
      : accounts.some((a) => a.provider === way.account)
      ? [{ way, account: way.account! }]
      : []
  );
  const others = plan.ways.filter((w) => !places.some((p) => p.way === w));
  const nameOf = (id: string) => machines.find((m) => m.computer._id === id)?.name ?? id;
  const ready = card.state === "ready" ? card : undefined;
  return (
    <Card as="li" padding="none" className="plan" data-state={card.state} aria-labelledby={titleId}>
      <div className="plan-head">
        <span className="plan-mark" aria-hidden="true">
          <Icon name="sparkles" size={20} />
        </span>
        <div className="plan-titles">
          <h3 className="plan-title" id={titleId}>
            {sayText(plan.plan)}
            {ready ? <Badge tone="success">{say("flowConnected")}</Badge> : null}
          </h3>
          <p className="plan-about" data-tone={toneOf(card)}>{sentence(card)}</p>
          {ready?.also
            ? (
              <p className="plan-about">
                {say("cardAlso", {
                  cli: ready.also.way.engine ? cliOf(ready.also.way.engine) : ready.also.way.title,
                  computer: ready.also.on.name,
                })}
              </p>
            )
            : null}
          {ready?.limited
            ? (
              <p className="plan-about" data-tone="warning">
                {say.nodes("cardLimited", { time: <Time at={ready.limited} /> })}
              </p>
            )
            : null}
          {ready?.on?.kind
            ? (
              <LazyView
                kind="computer.cost"
                item={{ computer: ready.on.computer._id }}
                hints={{ mode: "cost" }}
                fallback={null}
              />
            )
            : null}
        </div>
        <div className="plan-actions">
          {card.state === "off"
            ? (
              <Button
                variant="primary"
                onClick={() => connect()}
              >
                {say("connect")}
              </Button>
            )
            : !ready
            ? (
              <Button
                variant="primary"
                onClick={() => connect(card.way.provider)}
              >
                {say("fix")}
              </Button>
            )
            : null}
          {places.length
            ? (
              <Menu
                label={say("moreFor", { plan: sayText(plan.plan) })}
                items={[
                  ...places.map((p) => ({
                    label: p.computer
                      ? say("signOutOn", { computer: nameOf(p.computer) })
                      : say("signOutServer", { plan: sayText(p.way.title) }),
                    icon: "signout" as const,
                    onSelect: () => signOut(p),
                  })),
                  ...(ready
                    ? others.map((w) => ({
                      label: w.engine
                        ? say("alsoThrough", { cli: cliOf(w.engine) })
                        : sayText(w.title),
                      icon: "plus" as const,
                      onSelect: () =>
                        connect(w.provider),
                    }))
                    : []),
                ]}
              />
            )
            : null}
        </div>
      </div>
    </Card>
  );
}

/** Who an account is, with its plan: "ana@example.com (Plus)". */
const whoOf = (account: Account) =>
  account.plan ? `${account.label} (${account.plan})` : account.label;

/** A card's sentence: how the plan stands, in a line. */
export function sentence(card: Standing): string {
  switch (card.state) {
    case "ready":
      if (card.account) return say("cardReadyServer", { account: whoOf(card.account) });
      return card.backup
        ? say("cardReadyBackup", {
          computer: card.on!.name,
          state: stateOf(card.on!),
          backup: card.backup.name,
        })
        : say("cardReady", { computer: card.on!.name, state: stateOf(card.on!) });
    case "away":
      return say("cardAway", {
        computers: listed(card.on.map((m) => m.name)),
        count: card.on.length,
      });
    case "broken":
      return card.why === "reconnect"
        ? say("cardReconnect", { plan: sayText(card.way.title) })
        : say("cardShared", { computers: listed(card.on.map((m) => m.name)) });
    case "off":
      return say("cardOff");
  }
}

/** A computer that serves a plan now: online, or asleep (it wakes). */
const stateOf = (m: Machine) => m.computer.online ? say("cardOnline") : say("cardAsleep");

const toneOf = (card: Standing) =>
  card.state === "ready" ? "success" : card.state === "off" ? undefined : "warning";
