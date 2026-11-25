/**
 * A person's plans on their own computers (kind `computer.plans`, a section
 * of Connected accounts: the accounts plugin's `accountSections`): one card
 * per plan (Claude, ChatGPT through Codex, Google AI through Antigravity),
 * each computer of theirs saying whether its CLI is installed and signed in,
 * as whom, and what to do: sign in (a dialog that picks the computer and
 * runs the CLI's own sign-in there, installing a missing CLI first on macOS
 * and Linux), install the CLI by hand (its official command, on Windows),
 * or, on a computer others' agents work on as them, why it can't be used and
 * how to change that. With no computer yet, connecting one (or adding a
 * cloud computer, a kind's) comes first.
 *
 * What it reads is live: the person's computers (`computer.mine`, with what
 * each last said of its CLIs), where each works (`desk.of`) and the spaces
 * (`space.reached`): shared somewhere, it says where. As it opens, and when
 * the person comes back to the page (from a terminal, having installed a
 * CLI) or a computer comes online, it asks the computers again
 * (`computer.engines`), which keeps what they say on them. `?signin=claude`
 * opens the sign-in (the command palette's).
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Button, go, Icon, message, Notice, Skeleton } from "../../../../../hosts/web/mod.ts";
import type { Reached } from "../../../../access/spaces/contract.ts";
import type { ComputerEngines } from "../../actions/engines.ts";
import type { Computer } from "../../collections/computer.ts";
import type { Desk } from "../../collections/desk.ts";
import { AddDialog, type AddStep } from "./add.tsx";
import { ConnectDialog } from "./connect.tsx";
import { blockedBy, type Kind, kindByComputer, kindsOf, queryOf } from "./kinds.ts";
import { nameOf } from "./names.ts";
import { PlanCard } from "./plan-card.tsx";
import { SharedDialog } from "./plan-shared.tsx";
import { SignInDialog } from "./plan-sign-in.tsx";
import { isShared, listed, type Machine, planOf, plans, sharedIn } from "./plan-states.ts";
import { STYLE } from "./style.ts";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** Asked again on coming back to the page at most this often. */
const AGAIN_MS = 15_000;

export const plansView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const mine = ctx.db.collection("computer").query<Computer[]>("mine", {}).value;
  const spaces = ctx.db.collection("space").query<Reached[]>("reached", {}).value;
  // Where each works: shared into a space where others' agents work on it as them, it can't be used.
  const desks = (mine ?? []).map((c) =>
    ctx.db.collection("desk").query<Desk[]>("of", { computer: c._id }).value
  );
  // Cloud computers (a kind's): they wake when asked, and say their state their own way.
  const kinds = kindsOf(ctx.resources.computerKinds);
  const records = kinds.map((k) => {
    const [collection, query] = queryOf(k.mine)!;
    return ctx.db.collection(collection).query<{ _id: string }[]>(query, {}).value;
  });
  // With no computer yet: whether the person may make each kind now, for adding one.
  const makeable = mine?.length === 0
    ? kinds.map((k) => {
      const named = k.add?.available ? queryOf(k.add.available) : undefined;
      return named ? ctx.db.collection(named[0]).query<unknown>(named[1], {}).value : undefined;
    })
    : [];
  const style = <style href="computers-web" precedence="copilotz">{STYLE}</style>;
  if (
    mine === undefined || spaces === undefined || desks.some((d) => d === undefined) ||
    records.some((r) => r === undefined)
  ) {
    return (
      <section className="plans" aria-busy="true" aria-label={say("plansTitle")}>
        {style}
        <Skeleton height={22} width={220} />
        <Skeleton height={120} radius="xl" />
      </section>
    );
  }
  const kindOf = kindByComputer(kinds, records);
  const machines: Machine[] = mine.map((computer, i) => {
    const kind = kindOf[computer._id];
    return {
      computer,
      name: nameOf(computer),
      ...(kind ? { kind: { view: kind.view, ...(kind.icon ? { icon: kind.icon } : {}) } } : {}),
      shared: sharedIn(desks[i] ?? [], spaces),
    };
  });
  const offered = kinds.map((k, i) => {
    const blocked = blockedBy(k, makeable[i]);
    return blocked ? { ...k, blocked } : k;
  });
  const query = (ctx.hints.query ?? {}) as Record<string, string>;
  return (
    <>
      {style}
      <Plans
        machines={machines}
        computers={mine}
        asked={planOf(query.signin)?.engine}
        personal={spaces.find((s) => s.kind === "personal")?._id}
        kinds={offered}
        kindOf={kindOf}
        call={ctx.call}
      />
    </>
  );
};

/** The sign-in dialog's subject: a plan, and the computer picked for it, if one was. */
type Signing = { engine: string; computer?: string; from: "card" | "row" | "address" };

function Plans(
  { machines: live, computers, asked, personal, kinds, kindOf, call }: {
    machines: Machine[];
    /** The person's computers, live: a new one online is the one a code connected. */
    computers: Computer[];
    /** The plan the address asks to sign in (`?signin=`). */
    asked?: string;
    /** The person's Personal space: a computer connected from here goes there, theirs alone. */
    personal?: string;
    kinds: Kind[];
    kindOf: Record<string, Kind>;
    call: Call;
  },
): ReactNode {
  // What the computers said when asked: shared where the person doesn't reach it too.
  const [said, setSaid] = useState<Record<string, ComputerEngines>>({});
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [signing, setSigning] = useState<Signing | undefined>(
    asked ? { engine: asked, from: "address" } : undefined,
  );
  const [fixing, setFixing] = useState<string>();
  const [adding, setAdding] = useState<AddStep>();
  const last = useRef(0);

  const check = async () => {
    last.current = Date.now();
    setChecking(true);
    setProblem(undefined);
    try {
      const answer = await call<ComputerEngines[]>("computer.engines", {});
      setSaid(Object.fromEntries(answer.map((c) => [c.computer, c])));
    } catch (error) {
      setProblem(message(error));
    } finally {
      setChecking(false);
    }
  };
  // Asked as it opens, and again as a computer comes online.
  const online = live.filter((m) => m.computer.online).map((m) => m.computer._id).sort().join();
  useEffect(() => void check(), [online]);
  // Back on the page (from a terminal, having installed a CLI): asked again.
  useEffect(() => {
    const back = () => {
      if (Date.now() - last.current > AGAIN_MS) void check();
    };
    addEventListener("focus", back);
    return () => removeEventListener("focus", back);
  }, []);
  // Asked for by the address (the palette's "Sign in to your Claude plan"), on this page already or not.
  useEffect(() => {
    if (asked) setSigning({ engine: asked, from: "address" });
  }, [asked]);

  // Shared as the spaces the person reaches say, or as the server does where they don't reach.
  const machines = live.map((m): Machine =>
    isShared(m) ? m : { ...m, shared: said[m.computer._id]?.shared ? true : false }
  );
  const closeSigning = () => {
    if (signing?.from === "address") go("/accounts");
    setSigning(undefined);
  };
  const signingPlan = planOf(signing?.engine);
  const fixingMachine = machines.find((m) => m.computer._id === fixing);
  // A kind to make one of (a cloud computer) is a choice beside connecting their own machine.
  const viaAdd = !!personal && kinds.some((k) => k.add);
  const connect = () => setAdding(viaAdd ? "choose" : "connect");

  return (
    <section className="plans" aria-labelledby="plans-title">
      <header className="plans-head">
        <div className="plans-titles">
          <h2 id="plans-title">{say("plansTitle")}</h2>
          <p>{say("plansAbout")}</p>
        </div>
        {machines.length
          ? (
            <div className="plans-tools">
              <Button size="sm" variant="ghost" icon="plus" onClick={connect}>
                {say("connectComputer")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="refresh"
                loading={checking}
                onClick={() => void check()}
              >
                {checking ? say("checking") : say("checkAgain")}
              </Button>
            </div>
          )
          : null}
      </header>
      {problem
        ? (
          <Notice tone="warning" role="alert">
            {say("checkFailed", { why: problem })}
          </Notice>
        )
        : null}
      {machines.filter(isShared).map((m) => (
        <Notice
          key={m.computer._id}
          tone="neutral"
          icon="users"
          className="plans-shared"
          action={
            <Button size="sm" onClick={() => setFixing(m.computer._id)}>
              {say("howToFix")}
            </Button>
          }
        >
          {Array.isArray(m.shared)
            ? say("sharedNotice", {
              computer: m.name,
              spaces: listed(m.shared.map((s) => s.name)),
            })
            : say("sharedNoticeSomewhere", { computer: m.name })}
        </Notice>
      ))}
      {machines.length
        ? (
          <ul className="plans-list">
            {plans().map((plan) => (
              <PlanCard
                key={plan.engine}
                plan={plan}
                machines={machines}
                check={check}
                checking={checking}
                signIn={(computer) =>
                  setSigning({
                    engine: plan.engine,
                    from: computer ? "row" : "card",
                    ...(computer ? { computer } : {}),
                  })}
              />
            ))}
          </ul>
        )
        : <NoComputer connect={connect} />}
      <p className="plans-foot">
        <Icon name="lock" size={14} />
        <span>{say("plansPrivate")}</span>
      </p>
      {signingPlan
        ? (
          <SignInDialog
            key={`${signingPlan.engine}:${signing?.computer ?? ""}`}
            plan={signingPlan}
            machines={machines}
            picked={signing?.computer}
            open
            onClose={closeSigning}
            check={check}
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
      {adding && viaAdd
        ? (
          <AddDialog
            step={adding}
            go={setAdding}
            onClose={() => setAdding(undefined)}
            call={call}
            computers={computers}
            space={personal!}
            where={say("personal")}
            kinds={kinds}
            kindOf={kindOf}
            others={[]}
            share={() => {}}
          />
        )
        : adding
        ? (
          <ConnectDialog
            open
            onClose={() => setAdding(undefined)}
            call={call}
            computers={computers}
          />
        )
        : null}
    </section>
  );
}

/** No computer of theirs yet: what plans need, and connecting one. */
function NoComputer({ connect }: { connect(): void }): ReactNode {
  return (
    <div className="plans-none">
      <span className="plans-none-mark" aria-hidden="true">
        <Icon name="computer" size={22} />
      </span>
      <div className="plans-none-text">
        <h3>{say("noComputerTitle")}</h3>
        <p>{say("noComputerText")}</p>
        <ul className="plans-none-list" aria-label={say("plansTitle")}>
          {plans().map((plan) => (
            <li key={plan.engine}>
              <Icon name="sparkles" size={14} />
              <span>{plan.title}</span>
            </li>
          ))}
        </ul>
      </div>
      <Button variant="primary" icon="plus" className="plans-none-go" onClick={connect}>
        {say("connectComputer")}
      </Button>
    </div>
  );
}
