/**
 * Your plans (kind `computer.plans`, a section of Your AI: the accounts
 * plugin's `accountSections`, with `plans: true`, so the accounts that pay
 * for models show here, not as cards of their own): one card per plan the
 * app uses (plan-card.tsx), as the app's tiers list them in the person's
 * order, or every plan the app has; the person's order of them, when the
 * tiers keep one ("Use my plans in this order", Move up); and the connect
 * flow (connect-flow.tsx), from a card's Connect or Fix, or the address:
 * `?connect=claude-plan,chatgpt` (plans or ways in, by name), the fix-it
 * link the palette and other pages use.
 *
 * What it reads is live (plans-data.ts). As it opens, and as a computer
 * comes online, it asks the person's computers that are on what their CLIs
 * are now (`computer.engines`), which keeps it on them.
 */
import { type ReactNode, useEffect, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  go,
  Icon,
  IconButton,
  message,
  Notice,
  sayText,
  Skeleton,
} from "../../../../../hosts/web/mod.ts";
import { ConnectFlow } from "./connect-flow.tsx";
import { PlanCard, type SignedIn } from "./plan-card.tsx";
import { type PlansData, plansData } from "./plans-data.ts";
import type { PlanShown } from "./plan-states.ts";
import { STYLE } from "./style.ts";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** Your plans, the View (`computer.plans`). */
export const plansView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const data = plansData(ctx);
  const style = <style href="computers-web" precedence="copilotz">{STYLE}</style>;
  if (!data) {
    return (
      <section className="plans" aria-busy="true" aria-label={say("plansTitle")}>
        {style}
        <Skeleton height={22} width={220} />
        <Skeleton height={96} radius="xl" />
      </section>
    );
  }
  // Asked for by the address: plans or ways in this app has, by name.
  const query = (ctx.hints.query ?? {}) as Record<string, string>;
  const known = new Set(data.plans.flatMap((p) => [p.plan, ...p.ways.map((w) => w.provider)]));
  const asked = (query.connect ?? "").split(",").filter((name) => known.has(name));
  return (
    <>
      {style}
      <Plans {...data} asked={asked} call={ctx.call} />
    </>
  );
};

/** The flow, open: for these plans or ways, from a card or from the address. */
type Connecting = { picked: string[]; address: boolean };

function Plans(
  { plans, machines, computers, kinds, accounts, list, personal, asked, call }:
    & PlansData
    & { asked: string[]; call: Call },
): ReactNode {
  const [connecting, setConnecting] = useState<Connecting>();
  const [problem, setProblem] = useState<string>();
  useEffect(() => {
    if (asked.length) setConnecting({ picked: asked, address: true });
  }, [asked.join()]);
  // What their computers that are on say of their CLIs now, kept on them.
  const online = machines.filter((m) => m.computer.online).map((m) => m.computer._id).sort().join();
  useEffect(() => {
    void call("computer.engines", {}).catch((error) =>
      setProblem(say("checkFailed", { why: message(error) }))
    );
  }, [online]);

  const signOut = async (where: SignedIn) => {
    setProblem(undefined);
    try {
      if (where.computer) {
        await call("computer.engine.logout", {
          computer: where.computer,
          engine: where.way.engine,
        });
      } else await call("account.disconnect", { provider: where.account });
    } catch (error) {
      const name = machines.find((m) => m.computer._id === where.computer)?.name ??
        sayText(where.way.title);
      setProblem(say("signOutFailed", { computer: name, why: message(error) }));
    }
  };
  const close = () => {
    if (connecting?.address) go("/accounts");
    setConnecting(undefined);
  };

  return (
    <section className="plans" aria-labelledby="plans-title">
      <header className="plans-head">
        <div className="plans-titles">
          <h2 id="plans-title">{say("plansTitle")}</h2>
          <p>{say("plansAbout")}</p>
        </div>
      </header>
      {problem ? <Notice tone="warning" role="alert">{problem}</Notice> : null}
      <ul className="plans-list">
        {plans.map((plan) => (
          <PlanCard
            key={plan.plan}
            plan={plan}
            machines={machines}
            accounts={accounts}
            connect={(provider) =>
              setConnecting({ picked: [provider ?? plan.plan], address: false })}
            signOut={(where) => void signOut(where)}
          />
        ))}
      </ul>
      {list?.order ? <Order plans={plans} action={list.order} call={call} /> : null}
      <p className="plans-foot">
        <Icon name="lock" size={14} />
        <span>
          {/* What pays: their plan; a computer the app keeps for it, while it's awake. */}
          {[say("plansPaid"), ...(kinds.length ? [say("plansCloud")] : []), say("plansPrivate")]
            .join(" ")}
        </span>
      </p>
      {connecting
        ? (
          <ConnectFlow
            plans={plans}
            picked={connecting.picked}
            machines={machines}
            computers={computers}
            accounts={accounts}
            kinds={kinds}
            {...(personal ? { personal } : {})}
            onClose={close}
            call={call}
          />
        )
        : null}
    </section>
  );
}

/**
 * The person's order of their plans' ways in, as the app's tiers keep it:
 * Move up on each, saved at once (`planList`'s `order`: `{ harnesses }`,
 * as `tiers.harnesses` takes it).
 */
function Order(
  { plans, action, call }: { plans: PlanShown[]; action: string; call: Call },
): ReactNode {
  const ways = plans.flatMap((p) => p.ways);
  const [order, setOrder] = useState(() => ways.map((w) => w.provider));
  const [problem, setProblem] = useState<string>();
  useEffect(() => setOrder(ways.map((w) => w.provider)), [ways.map((w) => w.provider).join()]);
  if (ways.length < 2) return null;
  const up = async (i: number) => {
    const next = [...order];
    next.splice(i - 1, 0, ...next.splice(i, 1));
    setOrder(next);
    setProblem(undefined);
    await call(action, { harnesses: next }).catch((error) =>
      setProblem(say("orderFailed", { why: message(error) }))
    );
  };
  return (
    <section className="plans-order" aria-labelledby="plans-order-title">
      <h3 id="plans-order-title">{say("orderTitle")}</h3>
      <p className="plan-quiet">{say("orderAbout")}</p>
      {problem ? <Notice tone="warning" role="alert">{problem}</Notice> : null}
      <ol className="plans-order-list">
        {order.map((provider, i) => {
          const way = ways.find((w) => w.provider === provider);
          return way
            ? (
              <li key={provider}>
                <span className="plans-order-n">{i + 1}</span>
                <span className="plans-order-name">
                  {sayText(way.title)}
                  {way.connected === false
                    ? <span className="plan-quiet">· {say("notConnected")}</span>
                    : null}
                </span>
                <IconButton
                  icon="chevron-down"
                  className="plans-order-up"
                  label={say("moveUp")}
                  size="sm"
                  disabled={i === 0}
                  onClick={() => void up(i)}
                />
              </li>
            )
            : null;
        })}
      </ol>
    </section>
  );
}
