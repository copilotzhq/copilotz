/**
 * A space's agents' models, on its Members tab (spaces' `spaceAgents`).
 *
 * - Above its agents (kind `tiers.space`, item `{ _id }`, the space): the
 *   tier new chats here start on, and for its managers a choice of every
 *   tier, each with what a typical message comes to, or the org's default
 *   again. Anyone still switches a chat's own as they write.
 * - On each agent (kind `tiers.agent`, item `{ _id }`, the agent): its model
 *   here, its kind of work and the tier ("Claude Haiku 5.5 · Checks · on
 *   Everyday"). Models are the tiers', by kind of work: none is picked here.
 *
 * Both are watched reads, so a change shows at once, wherever it was made.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "copilotz";
import { Icon, message, Select } from "copilotz/web";
import type { AgentNow, Shown } from "../../contract.ts";
import { STYLE } from "./style.ts";
import { say } from "./say.ts";
import { sayText } from "copilotz/web/words";
import { bySaid, modelSaid, perReply, shownSaid, unitSaid } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

const style = <style href="tiers-web" precedence="copilotz">{STYLE}</style>;

export const tiersSpaceView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const space = item._id ?? String(ctx.hints.in ?? "");
  const shown = shownSaid(
    ctx.db.collection("modelChoice").query<Shown>("offered", { space }).value,
  );
  if (!shown?.tiers.length) return null;
  return (
    <>
      {style}
      <SpaceTier shown={shown} space={space} manage={ctx.hints.manage === true} call={ctx.call} />
    </>
  );
};

/** The space's tier: what new chats here start on, who chose it, and choosing another. */
export function SpaceTier(
  { shown, space, manage, call }: { shown: Shown; space: string; manage: boolean; call: Call },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const title = (name?: string | null) => shown.tiers.find((t) => t.name === name)?.title;
  const above = shown.org.tier ?? shown.plan ?? shown.tiers[0]?.name;
  const here = shown.space?.tier ?? above;
  const said = shown.space?.tier
    ? say("spaceChosen", { tier: title(above) ?? "" })
    : say("spaceAsOrg");
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
        <b>{say("spaceStartsOn", { tier: title(here) ?? "" })}</b>
        <span>
          {said} {say("spaceSwitch")} {manage ? "" : say("spaceManagers")}
        </span>
      </div>
      {manage
        ? (
          <Select
            size="sm"
            aria-label={say("spaceSelect")}
            value={shown.space?.tier ?? ""}
            disabled={busy}
            onChange={(event) => void choose(event.target.value)}
          >
            <option value="">{say("asOrg", { tier: title(above) ?? "" })}</option>
            {shown.tiers.map((tier) => {
              const price = perReply(tier.price);
              return (
                <option key={tier.name} value={tier.name}>
                  {tier.title}
                  {price ? ` · ${price} ${unitSaid(shown.per)}` : ""}
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
  const now = ctx.db.collection("modelChoice").query<AgentNow | null>("agent", {
    agent,
    ...(space ? { space } : {}),
  }).value;
  // No tier applies (or still reading): nothing to say.
  if (!now) return null;
  return (
    <>
      {style}
      <span className="tiers-line" title={`${modelSaid(now.model)}, ${bySaid(now.by)}`}>
        {say.nodes("agentLine", {
          model: <b>{now.model.name}</b>,
          kind: sayText(now.kindTitle),
          tier: sayText(now.tierTitle),
        })}
      </span>
    </>
  );
};
