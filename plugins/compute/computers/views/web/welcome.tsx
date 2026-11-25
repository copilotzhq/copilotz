/**
 * The welcome's step "Which AI plans do you have?" (kind
 * `computer.plans.welcome`, for an app's chat `welcome` resource): the plans
 * the app uses, to pick, and "None of these". Picked, "Connect them" opens
 * the connect flow over the welcome, for those; back, each says how it
 * stands. None, or the welcome's Next without connecting, goes on: the
 * app's models answer.
 *
 * ```ts
 * welcome: {
 *   plans: { title: "Which AI plans do you have?", view: "computer.plans.welcome", order: 15 },
 * }
 * ```
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Badge, Button, Checkbox, sayText, Skeleton } from "../../../../../hosts/web/mod.ts";
import { ConnectFlow } from "./connect-flow.tsx";
import { type PlansData, plansData } from "./plans-data.ts";
import { cardOf } from "./plan-states.ts";
import { STYLE } from "./style.ts";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export const plansWelcomeView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const data = plansData(ctx);
  const style = <style href="computers-web" precedence="copilotz">{STYLE}</style>;
  return (
    <>
      {style}
      {data ? <Welcome {...data} call={ctx.call} /> : <Skeleton height={140} radius="lg" />}
    </>
  );
};

function Welcome(data: PlansData & { call: Call }): ReactNode {
  const { plans, machines, accounts } = data;
  const [picks, setPicks] = useState<string[]>([]);
  const [none, setNone] = useState(false);
  const [open, setOpen] = useState(false);
  const pick = (plan: string) => {
    setNone(false);
    setPicks(picks.includes(plan) ? picks.filter((p) => p !== plan) : [...picks, plan]);
  };
  return (
    <div className="flow-welcome">
      <ul className="flow-picks">
        {plans.map((plan) => {
          const ready = cardOf(plan, machines, accounts).state === "ready";
          return (
            <li key={plan.plan}>
              <Checkbox
                className="flow-pick"
                checked={picks.includes(plan.plan)}
                onChange={() => pick(plan.plan)}
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
        <li>
          <Checkbox
            className="flow-pick"
            checked={none}
            onChange={() => {
              setNone(!none);
              setPicks([]);
            }}
            label={<span className="flow-pick-text">{say("welcomeNone")}</span>}
          />
        </li>
      </ul>
      {none
        ? <p className="plan-quiet">{say("welcomeNoneThen")}</p>
        : picks.length
        ? (
          <div className="flow-welcome-go">
            <Button variant="primary" onClick={() => setOpen(true)}>{say("welcomeConnect")}</Button>
            <span className="plan-quiet">{say("welcomeLater")}</span>
          </div>
        )
        : <p className="plan-quiet">{say("welcomeLater")}</p>}
      {open
        ? (
          <ConnectFlow
            plans={plans}
            picked={picks}
            machines={machines}
            computers={data.computers}
            accounts={accounts}
            kinds={data.kinds}
            {...(data.personal ? { personal: data.personal } : {})}
            onClose={() => setOpen(false)}
            call={data.call}
          />
        )
        : null}
    </div>
  );
}
