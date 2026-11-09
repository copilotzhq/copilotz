/**
 * The org's agents' models (kind `tiers.org`, a section of the org's page,
 * the web shell's `orgSettings`, at `/org?tab=models`). It opens with what's
 * in use and who chose it, then the tiers as cards, side by side: each its
 * name, what it's good for, what a typical reply comes to at this org's
 * prices, and each agent's model; the one in use outlined and marked with
 * where it comes from ("Your plan's default", "Chosen by your org"). Owners
 * and admins move to another in one click, with Undo right after; anyone else
 * reads it, and is told who changes it. Under the cards, each agent's model
 * now, and Customize: a model per agent, with the picker an agent's model is
 * chosen with (team's `model.pick`), the tier's list kept behind it, and the
 * way back to the tier, for one agent or all. What's shown is a watched read
 * (`modelChoice.offered`), so a change shows at once, wherever it was made.
 */
import { type ReactNode, useEffect, useState } from "react";
import type { ViewContext } from "copilotz";
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  LazyView,
  message,
  Notice,
  Skeleton,
} from "copilotz/web";
import { runs } from "copilotz/plugins/interfaces/contract";
import type { ModelPick } from "../../../team/contract.ts";
import type { AgentNow, Shown, TierShown } from "../../contract.ts";
import { STYLE } from "./style.ts";
import { chosenSaid, effortSaid, orgFromSaid, perReply } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** How long "Undo" stays after a change. */
const UNDO_MS = 12_000;

export const tiersOrgView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const shown = ctx.db.collection("modelChoice").query<Shown>("offered", {}).value;
  const may = runs({
    role: (ctx.hints.role as string | null | undefined) ?? null,
    staff: ctx.hints.staff === true,
  });
  const org = ctx.hints.org as { name?: string } | undefined;
  return (
    <>
      <style href="tiers-web" precedence="copilotz">{STYLE}</style>
      {shown ? <OrgModels shown={shown} may={may} org={org?.name} call={ctx.call} /> : <Loading />}
    </>
  );
};

function Loading(): ReactNode {
  return (
    <div className="tiers" aria-busy="true">
      <Skeleton height={22} width="55%" />
      <div className="tiers-cards">
        {[0, 1, 2, 3].map((n) => <Skeleton key={n} height={300} radius="xl" />)}
      </div>
      <Skeleton height={220} radius="xl" />
    </div>
  );
}

/** A change just made, and how to take it back. */
type Done = { said: string; tier: string | null };

export function OrgModels(
  { shown, may, org, call }: { shown: Shown; may: boolean; org?: string; call: Call },
): ReactNode {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<Done>();
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(undefined), UNDO_MS);
    return () => clearTimeout(timer);
  }, [done]);
  if (!shown.tiers.length) {
    return (
      <EmptyState icon="bot" title="No tiers to choose from">
        This app's agents each think with the model it gives them.
      </EmptyState>
    );
  }
  const now = shown.now.tier;
  const title = (name?: string | null) => shown.tiers.find((t) => t.name === name)?.title;
  const choose = async (tier: string | null, undoing = false) => {
    setBusy(tier ?? "plan");
    setError(undefined);
    try {
      const before = shown.org.tier;
      await call("tiers.choose", { tier });
      const to = tier ? title(tier) : title(shown.plan);
      setDone(
        undoing ? undefined : {
          said: to
            ? `Your agents use ${to} from their next reply.`
            : "Your agents use their own models from their next reply.",
          tier: before,
        },
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="tiers">
      <div className="tiers-now">
        <p>
          {now
            ? (
              <>
                Your agents use <b>{title(now.name)}</b>
                {now.by === "plan" ? ", your plan's default." : ", chosen by your org."}
              </>
            )
            : "Your agents each use their own model."} Spaces can choose their own.
        </p>
        {may && now?.by === "org" && shown.plan
          ? (
            <Button
              size="sm"
              variant="ghost"
              loading={busy === "plan"}
              disabled={!!busy}
              onClick={() => void choose(null)}
            >
              Back to your plan's default
            </Button>
          )
          : null}
      </div>
      {done
        ? (
          <Notice
            tone="success"
            role="status"
            action={
              <Button
                size="sm"
                onClick={() => void choose(done.tier, true)}
                disabled={!!busy}
              >
                Undo
              </Button>
            }
          >
            {done.said}
          </Notice>
        )
        : null}
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      {may ? null : (
        <Notice tone="neutral" icon="lock">
          Only {org ? `${org}'s` : "the org's"}{" "}
          owners and admins change these. A space's managers choose for their space.
        </Notice>
      )}
      <ul className="tiers-cards" aria-label="Tiers">
        {shown.tiers.map((tier) => (
          <TierCard
            key={tier.name}
            tier={tier}
            current={now?.name === tier.name ? now.by : undefined}
            plan={shown.plan === tier.name}
            may={may}
            busy={busy}
            agents={shown.agents}
            onChoose={() => void choose(tier.name)}
          />
        ))}
      </ul>
      <EachAgent shown={shown} may={may} call={call} />
      <p className="tiers-foot">
        <Icon name="info" size={14} />
        <span>
          A typical reply here: about 20,000 tokens read, most of them from the cache, and 1,000
          written, at your org's prices. Real replies vary. What agents spend stays within your{" "}
          <a href="/org?tab=billing">budget</a>.
        </span>
      </p>
    </div>
  );
}

/** A tier: what it's for, what a reply comes to, each agent's model, and choosing it. */
export function TierCard(
  { tier, current, plan, may, busy, agents, onChoose }: {
    tier: TierShown;
    /** Who chose it, when it's the one in use. */
    current?: "space" | "org" | "plan";
    /** It's the plan's default. */
    plan: boolean;
    may: boolean;
    busy?: string;
    agents: Shown["agents"];
    onChoose(): void;
  },
): ReactNode {
  const price = perReply(tier.price);
  const named = (agent: string) => agents.find((a) => a.agent === agent);
  return (
    <Card
      as="li"
      className="tier-card"
      data-current={current ? true : undefined}
      aria-current={current ? "true" : undefined}
      aria-labelledby={`tier-${tier.name}`}
    >
      <div className="tier-card-top">
        <h3 id={`tier-${tier.name}`}>{tier.title}</h3>
        {current
          ? (
            <Badge tone="primary">
              <Icon name="check" size={12} />
              {chosenSaid(current)}
            </Badge>
          )
          : plan
          ? <Badge variant="outline">Plan default</Badge>
          : null}
      </div>
      {tier.description ? <p className="tier-card-for">{tier.description}</p> : null}
      <p className="tier-card-price">
        {price
          ? (
            <>
              <b>{price}</b> a typical reply
            </>
          )
          : "Priced as each model is"}
      </p>
      <ul className="tier-card-agents" aria-label={`${tier.title}'s models`}>
        {tier.agents.map(({ agent, model }) => (
          <li key={agent}>
            <span className="tier-who">
              {named(agent)?.icon ? <span aria-hidden="true">{named(agent)?.icon}</span> : null}
              {named(agent)?.name ?? agent}
            </span>
            <span className="tier-model">
              {model.name}
              {effortSaid(model.effort) ? <small>{effortSaid(model.effort)}</small> : null}
            </span>
          </li>
        ))}
      </ul>
      {may
        ? (
          <div className="tier-card-end">
            {current
              ? (
                <p className="tier-card-using">
                  <Icon name="check" size={15} /> In use
                </p>
              )
              : (
                <Button
                  loading={busy === tier.name}
                  disabled={!!busy}
                  onClick={onChoose}
                  aria-describedby={`tier-${tier.name}`}
                >
                  Use {tier.title}
                </Button>
              )}
          </div>
        )
        : null}
    </Card>
  );
}

/** Each agent's model now, and choosing one for it (Customize). */
function EachAgent({ shown, may, call }: { shown: Shown; may: boolean; call: Call }): ReactNode {
  const picks = Object.keys(shown.org.custom);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const tier = shown.tiers.find((t) => t.name === shown.now.tier?.name);
  const act = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    setError(undefined);
    try {
      await work();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  };
  const allBack = () =>
    act("all", () => call("tiers.choose", { tier: shown.org.tier, picks: null }));
  return (
    <Card as="section" className="tiers-agents" aria-labelledby="tiers-each">
      <div className="tiers-agents-head">
        <div>
          <h3 id="tiers-each">Each agent's model</h3>
          <p>
            {editing
              ? `Pick a model for any agent: it's used from the next reply, with ${
                tier ? `${tier.title}'s` : "its own"
              } behind it in case it fails.`
              : picks.length
              ? `${picks.length === 1 ? "One agent has" : `${picks.length} agents have`} a model ` +
                `picked by your org; ${tier ? `${tier.title}'s` : "its own"} stays behind it, ` +
                "in case it fails."
              : `${tier ? `As ${tier.title} has them.` : "Each its own."}${
                may ? " Customize to pick a different one for any agent." : ""
              }`}
          </p>
        </div>
        {may
          ? (
            <div className="tiers-agents-actions">
              {picks.length
                ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === "all"}
                    disabled={!!busy}
                    onClick={() => void allBack()}
                  >
                    {tier ? `Back to ${tier.title}` : "Back to their own"}
                  </Button>
                )
                : null}
              <Button
                size="sm"
                variant={editing ? "primary" : "secondary"}
                icon={editing ? "check" : "pencil"}
                aria-pressed={editing}
                onClick={() => setEditing(!editing)}
              >
                {editing ? "Done" : "Customize"}
              </Button>
            </div>
          )
          : null}
      </div>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      <ul className="tiers-rows">
        {shown.agents.map((agent) => {
          const now = shown.now.agents[agent.agent];
          if (!now) return null;
          return (
            <AgentRow
              key={agent.agent}
              agent={agent}
              now={now}
              picked={!!shown.org.custom[agent.agent]}
              back={tier ? `Use ${tier.title}'s` : "Use its own"}
              editing={may && editing}
              busy={busy === agent.agent}
              onBack={() =>
                void act(
                  agent.agent,
                  () => call("tiers.pick", { agent: agent.agent, model: null }),
                )}
            />
          );
        })}
      </ul>
    </Card>
  );
}

function AgentRow(
  { agent, now, picked, back, editing, busy, onBack }: {
    agent: Shown["agents"][number];
    now: AgentNow;
    picked: boolean;
    back: string;
    editing: boolean;
    busy: boolean;
    onBack(): void;
  },
): ReactNode {
  const price = perReply(now.model.price);
  const from = (
    <span className="tiers-row-from" data-picked={picked || undefined}>
      {orgFromSaid(now.from)}
    </span>
  );
  const pick: ModelPick = { action: "tiers.pick", input: { agent: agent.agent } };
  return (
    <li className="tiers-row" data-editing={editing || undefined} aria-busy={busy || undefined}>
      <Avatar name={agent.name} kind="agent" icon={agent.icon} size={32} />
      <div className="tiers-row-text">
        <p className="tiers-row-name">{agent.name}</p>
        {editing
          ? (
            <div className="tiers-row-pick">
              <LazyView
                kind="model.pick"
                item={{ value: now.model.id }}
                hints={pick}
                fallback={<Skeleton height={54} />}
              />
              <span className="tiers-row-under">
                {from}
                {price ? <span>{price} a typical reply</span> : null}
                {picked
                  ? (
                    <Button
                      variant="link"
                      size="sm"
                      className="tiers-back"
                      disabled={busy}
                      onClick={onBack}
                    >
                      {back}
                    </Button>
                  )
                  : null}
              </span>
            </div>
          )
          : (
            <p className="tiers-row-model">
              <b>{now.model.name}</b>
              {effortSaid(now.model.effort) ? `, ${effortSaid(now.model.effort)}` : ""} · {from}
              {now.model.ownKey ? " · on your key" : ""}
            </p>
          )}
      </div>
      {editing || !price ? null : <span className="tiers-row-price">{price} a reply</span>}
    </li>
  );
}
