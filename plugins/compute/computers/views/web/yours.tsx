/**
 * Your computers (kind `computer.yours`, a section of Your AI, below the
 * plans): each of the person's computers, its state (a cloud computer's as
 * its kind says it; else online, or when it was last seen), which plans it
 * runs, its month (the `computer.cost` View), its Terminal a click away,
 * and setting up their plans there (the connect flow, `?connect=…&on=`). One
 * shared with others' agents says so. Adding one goes through the computers'
 * own dialog, into their Personal space.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Button,
  go,
  LazyView,
  Menu,
  sayText,
  Skeleton,
  Time,
} from "../../../../../hosts/web/mod.ts";
import { AddDialog, type AddStep } from "./add.tsx";
import { ConnectDialog } from "./connect.tsx";
import { ComputerMark } from "./mark.tsx";
import { type PlansData, plansData } from "./plans-data.ts";
import { isShared, listed, seenOf } from "./plan-states.ts";
import { STYLE } from "./style.ts";
import { say } from "./words.ts";
import type { IconName } from "../../../../../hosts/web/mod.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** Your computers, the View (`computer.yours`). */
export const yoursView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const data = plansData(ctx);
  const style = <style href="computers-web" precedence="copilotz">{STYLE}</style>;
  if (!data) {
    return (
      <section className="plans" aria-busy="true" aria-label={say("yoursTitle")}>
        {style}
        <Skeleton height={60} radius="xl" />
      </section>
    );
  }
  return (
    <>
      {style}
      <Yours {...data} call={ctx.call} />
    </>
  );
};

function Yours(
  { machines, computers, plans, kinds, kindOf, personal, call }: PlansData & { call: Call },
): ReactNode {
  const [adding, setAdding] = useState<AddStep>();
  // The plans each runs, by the names Your plans give them.
  const runs = (computer: PlansData["computers"][number]) =>
    plans.filter((p) => p.ways.some((w) => w.engine && seenOf(computer, w.engine)?.signedIn))
      .map((p) => sayText(p.plan));
  // Its plans that run through an app on a computer, to set up there.
  const here = plans.flatMap((p) => p.ways.filter((w) => w.engine).slice(0, 1))
    .map((w) => w.provider).join(",");
  const viaAdd = !!personal && kinds.some((k) => k.add);
  return (
    <section className="plans yours" aria-labelledby="yours-title">
      <header className="plans-head">
        <div className="plans-titles">
          <h2 id="yours-title">{say("yoursTitle")}</h2>
          <p>{say("yoursAbout")}</p>
        </div>
        <div className="plans-tools">
          <Button
            size="sm"
            variant="ghost"
            icon="plus"
            onClick={() => setAdding(viaAdd ? "choose" : "connect")}
          >
            {say("addComputer")}
          </Button>
        </div>
      </header>
      {machines.length
        ? (
          <ul className="yours-list">
            {machines.map((m) => {
              const on = runs(m.computer);
              const href = `/computer/${encodeURIComponent(m.computer._id)}`;
              return (
                <li key={m.computer._id} className="yours-computer">
                  <ComputerMark
                    online={m.computer.online}
                    {...(m.kind?.icon ? { icon: m.kind.icon as IconName } : {})}
                  />
                  <div className="yours-text">
                    <span className="yours-name">{m.name}</span>
                    <span className="yours-state">
                      {m.kind
                        ? (
                          <LazyView
                            kind={m.kind.view}
                            item={{ _id: m.computer._id }}
                            hints={{ mode: "badge" }}
                            fallback={null}
                          />
                        )
                        : m.computer.online
                        ? say("online")
                        : (
                          <>
                            {say("offline")}
                            {m.computer.seen
                              ? (
                                <>
                                  {" · "}
                                  {say.nodes("seenAt", { time: <Time at={m.computer.seen} /> })}
                                </>
                              )
                              : null}
                          </>
                        )}
                      <span>
                        {" · "}
                        {isShared(m)
                          ? say("failShared", { computer: m.name })
                          : on.length
                          ? say("yoursServes", { plans: listed(on) })
                          : say("yoursServesNone")}
                      </span>
                    </span>
                    {m.kind
                      ? (
                        <LazyView
                          kind="computer.cost"
                          item={{ computer: m.computer._id }}
                          hints={{ mode: "month" }}
                          fallback={null}
                        />
                      )
                      : null}
                  </div>
                  <div className="yours-actions">
                    <Button size="sm" icon="terminal" href={href}>{say("terminal")}</Button>
                    {isShared(m) || !here ? null : (
                      <Menu
                        label={say("moreFor", { plan: m.name })}
                        items={[{
                          label: say("signInHere"),
                          icon: "sparkles",
                          onSelect: () =>
                            go(
                              `/accounts?connect=${encodeURIComponent(here)}&on=${
                                encodeURIComponent(m.computer._id)
                              }`,
                            ),
                        }]}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )
        : <p className="plan-quiet">{say("yoursNone")}</p>}
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
