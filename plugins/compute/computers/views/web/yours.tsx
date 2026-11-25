/**
 * Your computers (kind `computer.yours`, a section of Your AI, below the
 * plans): each of the person's computers, its state (a cloud computer's as
 * its kind says it; else online, or when it was last seen), which plans it
 * runs, or that it's shared with others' agents (so none), its month (the
 * `computer.cost` View) and its Terminal a click away.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import type { IconName } from "../../../../../hosts/web/mod.ts";
import { Button, LazyView, sayText, Skeleton, Time } from "../../../../../hosts/web/mod.ts";
import { ComputerMark } from "./mark.tsx";
import { type PlansData, plansData } from "./plans-data.ts";
import { isShared, listed, seenOf } from "./plan-states.ts";
import { STYLE } from "./style.ts";
import { say } from "./words.ts";

/** Your computers, the View (`computer.yours`). */
export const yoursView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const data = plansData(ctx);
  return (
    <>
      <style href="computers-web" precedence="copilotz">{STYLE}</style>
      {data ? <Yours {...data} /> : <Skeleton height={60} radius="xl" />}
    </>
  );
};

function Yours({ machines, plans }: PlansData): ReactNode {
  return (
    <section className="plans yours" aria-labelledby="yours-title">
      <header className="plans-head">
        <div className="plans-titles">
          <h2 id="yours-title">{say("yoursTitle")}</h2>
          <p>{say("yoursAbout")}</p>
        </div>
      </header>
      {machines.length
        ? (
          <ul className="yours-list">
            {machines.map((m) => {
              // The plans it runs, by the names Your plans give them.
              const runs = plans.filter((p) =>
                p.ways.some((w) => w.engine && seenOf(m.computer, w.engine)?.signedIn)
              ).map((p) => sayText(p.plan));
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
                          : runs.length
                          ? say("yoursServes", { plans: listed(runs) })
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
                  <Button
                    size="sm"
                    icon="terminal"
                    href={`/computer/${encodeURIComponent(m.computer._id)}`}
                  >
                    {say("terminal")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )
        : <p className="plan-quiet">{say("yoursNone")}</p>}
    </section>
  );
}
