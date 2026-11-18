/**
 * Choosing the org's tier when it's new (kind `tiers.setup`): a step of a
 * welcome, or anywhere a page wants the choice short. The tiers as one choice,
 * each its name, what it's good for, what a typical message comes to at this
 * org's prices, how far the plan's credits go at that, and a meter of how
 * much it spends next to the others; the plan's own marked Recommended. A
 * click chooses it for the org at once (`tiers.choose`, as the org's page
 * does: the plan's own goes back to following the plan), and on a plan of
 * credits given once, a heavier tier says how much faster it spends them. A
 * link goes on to the org's page, to pick a model per agent. Owners and
 * admins choose; anyone else reads it, and is told who can.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "copilotz";
import { Badge, Icon, message, Notice, Skeleton, Spinner } from "copilotz/web";
import { runs, useStanding } from "copilotz/plugins/interfaces/contract";
import type { Shown, TierShown } from "../../contract.ts";
import { SpendNote } from "./org.tsx";
import { STYLE } from "./style.ts";
import { say } from "./say.ts";
import { creditsGo, perReply, shownSaid, unitSaid } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export const tiersSetupView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const shown = shownSaid(ctx.db.collection("modelChoice").query<Shown>("offered", {}).value);
  // Given the person's role where it's shown (the org's page), else asked (a welcome's step).
  const given = "role" in ctx.hints
    ? runs({
      role: (ctx.hints.role as string | null | undefined) ?? null,
      staff: ctx.hints.staff === true,
    })
    : undefined;
  return (
    <>
      <style href="tiers-web" precedence="copilotz">{STYLE}</style>
      {shown
        ? <SetupTiers shown={shown} may={given} call={ctx.call} />
        : (
          <div className="tiers-setup" aria-busy="true">
            {[0, 1, 2, 3].map((n) => <Skeleton key={n} height={74} radius="lg" />)}
          </div>
        )}
    </>
  );
};

export function SetupTiers(
  { shown, may: given, call }: { shown: Shown; may?: boolean; call: Call },
): ReactNode {
  const standing = useStanding(call, given === undefined);
  const may = given ?? (standing ? runs(standing) : false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  // The org's default: what new chats start on.
  const now = shown.org.tier ?? shown.plan ?? shown.tiers[0]?.name;
  const top = Math.max(...shown.tiers.map((t) => t.price ?? 0));
  const choose = async (tier: TierShown) => {
    if (!may || busy || tier.name === now) return;
    setBusy(tier.name);
    setError(undefined);
    try {
      // The plan's own: back to following the plan, so a new plan moves it.
      await call("tiers.choose", { tier: tier.name === shown.plan ? null : tier.name });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="tiers-setup">
      <div className="tiers-options" role="radiogroup" aria-label={say("tiersLabel")}>
        {shown.tiers.map((tier) => {
          const price = perReply(tier.price);
          const goes = creditsGo(shown.credits, tier.price, shown.per);
          const checked = tier.name === now;
          // How much it spends next to the others: a quarter of the bar at least, the dearest full.
          const share = tier.price && top ? Math.max(tier.price / top, 0.04) : 0;
          return (
            <button
              key={tier.name}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-disabled={!may || undefined}
              aria-busy={busy === tier.name || undefined}
              className="tiers-option"
              data-checked={checked || undefined}
              onClick={() => void choose(tier)}
            >
              <span className="tiers-option-mark" aria-hidden="true">
                {busy === tier.name
                  ? <Spinner size={14} />
                  : checked
                  ? <Icon name="check" size={13} />
                  : null}
              </span>
              <span className="tiers-option-text">
                <span className="tiers-option-name">
                  {tier.title}
                  {tier.name === shown.plan
                    ? <Badge tone="primary">{say("recommended")}</Badge>
                    : null}
                </span>
                {tier.description
                  ? <span className="tiers-option-for">{tier.description}</span>
                  : null}
                {goes ? <span className="tiers-option-goes">{goes}</span> : null}
              </span>
              <span className="tiers-option-price">
                {price
                  ? (
                    <>
                      <b>{price}</b>
                      <small>{unitSaid(shown.per)}</small>
                    </>
                  )
                  : <small>{say("pricedEach")}</small>}
                {share
                  ? (
                    <span className="tiers-option-meter" aria-hidden="true">
                      <span style={{ inlineSize: `${Math.round(share * 100)}%` }} />
                    </span>
                  )
                  : null}
              </span>
            </button>
          );
        })}
      </div>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      {may || (given === undefined && !standing)
        ? <SpendNote shown={shown} tier={now} />
        : (
          <Notice tone="neutral" icon="lock">
            {say("ownersChoose")}
          </Notice>
        )}
    </div>
  );
}
