/**
 * A space's agents' models, on its Members tab (spaces' `spaceAgents`).
 *
 * - Above its agents (kind `tiers.space`, item `{ _id }`, the space): the
 *   tier its agents use and where it comes from ("Expert, as the org chose"),
 *   and for its managers a choice of every tier, each with what a typical
 *   reply comes to, or the org's again. Any tier: the org's budget bounds it.
 * - On each of the app's agents (kind `tiers.agent`, item `{ _id }`, the
 *   agent): the model it uses here and where that comes from ("Claude Haiku
 *   5.5 · the org's Everyday"); for managers, Change (the picker an agent's
 *   model is chosen with, team's `model.pick`) and, once picked, the way back
 *   to what it had. Agents people make say nothing here: their model is theirs.
 *
 * Both are watched reads, so a change shows at once, wherever it was made.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "copilotz";
import { Button, Icon, LazyView, message, Select } from "copilotz/web";
import type { ModelPick } from "../../../team/contract.ts";
import type { AgentNow, Shown } from "../../contract.ts";
import { STYLE } from "./style.ts";
import { effortSaid, perReply, spaceFromSaid } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

const style = <style href="tiers-web" precedence="copilotz">{STYLE}</style>;

export const tiersSpaceView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const space = item._id ?? String(ctx.hints.in ?? "");
  const shown = ctx.db.collection("modelChoice").query<Shown>("offered", { space }).value;
  if (!shown?.tiers.length) return null;
  return (
    <>
      {style}
      <SpaceTier shown={shown} space={space} manage={ctx.hints.manage === true} call={ctx.call} />
    </>
  );
};

/** The space's tier: what applies, who chose it, and choosing another. */
export function SpaceTier(
  { shown, space, manage, call }: { shown: Shown; space: string; manage: boolean; call: Call },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const title = (name?: string | null) => shown.tiers.find((t) => t.name === name)?.title;
  const now = shown.now.tier;
  const above = shown.org.tier ?? shown.plan;
  const said = now
    ? now.by === "space"
      ? `Chosen for this space.${above ? ` The org's is ${title(above)}.` : ""}`
      : now.by === "org"
      ? "As the org chose."
      : "Your plan's default, as the org hasn't chosen."
    : "Each agent uses its own.";
  const choose = async (tier: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await call("tiers.choose", { space, tier: tier || null });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tiers-space" aria-busy={busy || undefined}>
      <span className="tiers-space-mark" aria-hidden="true">
        <Icon name="sparkles" size={16} />
      </span>
      <div className="tiers-space-text">
        <b>Models: {now ? title(now.name) : "the agents' own"}</b>
        <span>
          {said} {manage
            ? "A change applies from each chat's next reply."
            : "This space's managers can change it."}
        </span>
      </div>
      {manage
        ? (
          <Select
            size="sm"
            aria-label="This space's models"
            value={shown.space?.tier ?? ""}
            disabled={busy}
            onChange={(event) => void choose(event.target.value)}
          >
            <option value="">
              {above ? `As the org: ${title(above)}` : "As the org: the agents' own"}
            </option>
            {shown.tiers.map((tier) => {
              const price = perReply(tier.price);
              return (
                <option key={tier.name} value={tier.name}>
                  {tier.title}
                  {price ? ` · ${price} a reply` : ""}
                </option>
              );
            })}
          </Select>
        )
        : null}
      {error ? <p className="tiers-space-error" role="alert">{error}</p> : null}
    </div>
  );
}

export const tiersAgentView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const agent = item._id ?? "";
  const space = String(ctx.hints.in ?? "");
  const now = ctx.db.collection("modelChoice").query<AgentNow & { without?: AgentNow } | null>(
    "agent",
    { agent, space },
  ).value;
  // Not one of the app's (or still reading): nothing to say.
  if (!now) return null;
  return (
    <>
      {style}
      <AgentLine
        now={now}
        agent={agent}
        space={space}
        manage={ctx.hints.manage === true}
        call={ctx.call}
      />
    </>
  );
};

/** What an agent thinks with here, where that comes from, and changing it. */
export function AgentLine(
  { now, agent, space, manage, call }: {
    now: AgentNow & { without?: AgentNow };
    agent: string;
    space: string;
    manage: boolean;
    call: Call;
  },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const effort = effortSaid(now.model.effort);
  const pick: ModelPick = {
    action: "tiers.pick",
    input: { space, agent },
    look: "link",
    label: "Change",
  };
  const back = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await call("tiers.pick", { space, agent, model: null });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <span
        className="tiers-line"
        data-picked={now.without ? true : undefined}
        title={effort ? `${now.model.name}, ${effort}` : undefined}
      >
        <b>{now.model.name}</b> · <span className="tiers-line-from">{spaceFromSaid(now.from)}</span>
      </span>
      {manage
        ? <LazyView kind="model.pick" item={{ value: now.model.id }} hints={pick} fallback={null} />
        : null}
      {manage && now.without
        ? (
          <Button
            variant="link"
            size="sm"
            className="tiers-back"
            disabled={busy}
            onClick={() => void back()}
            title={`Back to ${now.without.model.name}, ${spaceFromSaid(now.without.from)}`}
          >
            Back to {now.without.model.name}
          </Button>
        )
        : null}
      {error ? <span className="tiers-line" role="alert">{error}</span> : null}
    </>
  );
}
