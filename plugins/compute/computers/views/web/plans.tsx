/**
 * Your plans (kind `computer.plans`, a section of Your AI: the accounts
 * plugin's `accountSections`, with `plans: true`, so the accounts that pay
 * for models show here, not as cards of their own): one card per plan the
 * app uses (plan-card.tsx), as the app's tiers list them in the person's
 * order, or every plan the app has; the person's order of them, when the
 * tiers keep one ("Use my plans in this order", Move up and Move down); and
 * the connect flow (connect-flow.tsx), from a card's Connect or Fix, the
 * section's own button, or the address: `?connect=claude-plan,chatgpt`
 * (plans or ways in, by name; `&on=<computer>` to set them up there), the
 * fix-it link the palette, chat and other pages use.
 *
 * What it reads is live (plans-data.ts). As it opens, and when the person
 * comes back to the page, it asks their computers that are on what their
 * CLIs are now (`computer.engines`), which keeps it on them.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Button,
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
import { SharedDialog } from "./plan-shared.tsx";
import { type PlansData, plansData } from "./plans-data.ts";
import { isShared, listed, type PlanShown } from "./plan-states.ts";
import { STYLE } from "./style.ts";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** Asked again on coming back to the page at most this often. */
const AGAIN_MS = 15_000;

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
  const query = (ctx.hints.query ?? {}) as Record<string, string>;
  // Asked for by the address: plans or ways in this app has, by name.
  const known = new Set(data.plans.flatMap((p) => [p.plan, ...p.ways.map((w) => w.provider)]));
  const asked = (query.connect ?? "").split(",").filter((name) => known.has(name));
  return (
    <>
      {style}
      <Plans
        {...data}
        asked={asked}
        {...(query.on ? { on: query.on } : {})}
        call={ctx.call}
      />
    </>
  );
};

/** The flow, open: for these plans or ways (none: the person picks), on this computer. */
type Connecting = { picked?: string[]; on?: string; from: "page" | "address" };

function Plans(
  { plans, machines: live, computers, kinds, accounts, list, personal, asked, on, call }:
    & PlansData
    & { asked: string[]; on?: string; call: Call },
): ReactNode {
  const [connecting, setConnecting] = useState<Connecting | undefined>(
    asked.length ? { picked: asked, ...(on ? { on } : {}), from: "address" } : undefined,
  );
  const [problem, setProblem] = useState<string>();
  const [fixing, setFixing] = useState<string>();
  const [shared, setShared] = useState<Record<string, boolean>>({});
  const last = useRef(0);

  const check = async () => {
    last.current = Date.now();
    try {
      const said = await call<{ computer: string; shared: boolean }[]>("computer.engines", {});
      setShared(Object.fromEntries(said.map((c) => [c.computer, c.shared])));
    } catch (error) {
      setProblem(say("checkFailed", { why: message(error) }));
    }
  };
  const online = live.filter((m) => m.computer.online).map((m) => m.computer._id).sort().join();
  useEffect(() => void check(), [online]);
  useEffect(() => {
    const back = () => {
      if (Date.now() - last.current > AGAIN_MS) void check();
    };
    addEventListener("focus", back);
    return () => removeEventListener("focus", back);
  }, []);
  useEffect(() => {
    if (asked.length) setConnecting({ picked: asked, ...(on ? { on } : {}), from: "address" });
  }, [asked.join(), on]);

  // Shared as the spaces the person reaches say, or as the server does where they don't reach.
  const machines = live.map((m) =>
    isShared(m) ? m : { ...m, shared: shared[m.computer._id] ?? false }
  );
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
    if (connecting?.from === "address") go("/accounts");
    setConnecting(undefined);
  };
  const fixingMachine = machines.find((m) => m.computer._id === fixing);

  return (
    <section className="plans" aria-labelledby="plans-title">
      <header className="plans-head">
        <div className="plans-titles">
          <h2 id="plans-title">{say("plansTitle")}</h2>
          <p>{say("plansAbout")}</p>
        </div>
        <div className="plans-tools">
          <Button
            size="sm"
            variant="ghost"
            icon="plus"
            onClick={() => setConnecting({ from: "page" })}
          >
            {say("connectPlans")}
          </Button>
        </div>
      </header>
      {problem ? <Notice tone="warning" role="alert">{problem}</Notice> : null}
      {machines.filter(isShared).map((m) => (
        <Notice
          key={m.computer._id}
          tone="neutral"
          icon="users"
          className="plans-shared"
          action={
            <Button size="sm" onClick={() => setFixing(m.computer._id)}>{say("howToFix")}</Button>
          }
        >
          {Array.isArray(m.shared)
            ? say("sharedNotice", { computer: m.name, spaces: listed(m.shared.map((s) => s.name)) })
            : say("sharedNoticeSomewhere", { computer: m.name })}
        </Notice>
      ))}
      <ul className="plans-list">
        {plans.map((plan) => (
          <PlanCard
            key={plan.plan}
            plan={plan}
            machines={machines}
            accounts={accounts}
            connect={(provider) => setConnecting({ picked: [provider ?? plan.plan], from: "page" })}
            signOut={(where) => void signOut(where)}
          />
        ))}
      </ul>
      {list?.order ? <Order plans={plans} action={list.order} call={call} /> : null}
      <p className="plans-foot">
        <Icon name="lock" size={14} />
        <span>{say("plansPrivate")}</span>
      </p>
      {connecting
        ? (
          <ConnectFlow
            plans={plans}
            {...(connecting.picked ? { picked: connecting.picked } : {})}
            {...(connecting.on ? { on: connecting.on } : {})}
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
      {fixingMachine
        ? (
          <SharedDialog
            machine={fixingMachine}
            onClose={() => setFixing(undefined)}
            check={check}
            call={call}
          />
        )
        : null}
    </section>
  );
}

/**
 * The person's order of their plans' ways in, as the app's tiers keep it:
 * a list with Move up and Move down, saved at once (`planList`'s `order`).
 */
function Order(
  { plans, action, call }: { plans: PlanShown[]; action: string; call: Call },
): ReactNode {
  const ways = plans.flatMap((p) => p.ways);
  const [order, setOrder] = useState(() => ways.map((w) => w.provider));
  const [problem, setProblem] = useState<string>();
  useEffect(() => setOrder(ways.map((w) => w.provider)), [ways.map((w) => w.provider).join()]);
  if (ways.length < 2) return null;
  const move = async (from: number, to: number) => {
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setOrder(next);
    setProblem(undefined);
    try {
      await call(action, { order: next });
    } catch (error) {
      setProblem(say("orderFailed", { why: message(error) }));
    }
  };
  return (
    <section className="plans-order" aria-labelledby="plans-order-title">
      <h3 id="plans-order-title">{say("orderTitle")}</h3>
      <p className="plan-quiet">{say("orderAbout")}</p>
      {problem ? <Notice tone="warning" role="alert">{problem}</Notice> : null}
      <ol className="plans-order-list">
        {order.map((provider, i) => {
          const way = ways.find((w) => w.provider === provider);
          if (!way) return null;
          return (
            <li key={provider} data-connected={way.connected ?? undefined}>
              <span className="plans-order-n">{i + 1}</span>
              <span className="plans-order-name">
                {sayText(way.title)}
                {way.connected === false
                  ? <span className="plan-quiet">· {say("notConnected")}</span>
                  : null}
              </span>
              <IconButton
                icon="chevron-down"
                label={say("moveDown")}
                size="sm"
                disabled={i === order.length - 1}
                onClick={() => void move(i, i + 1)}
              />
              <IconButton
                icon="chevron-down"
                className="plans-order-up"
                label={say("moveUp")}
                size="sm"
                disabled={i === 0}
                onClick={() => void move(i, i - 1)}
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
}
