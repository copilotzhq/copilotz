/**
 * What a routine's agent may do on its own (kind `computer.routine`, on its
 * page, given the routine): for each computer of its space that the viewer
 * answers for, whether it may run commands, start jobs and change files when
 * this routine runs (`computer.allowOrigin`), so a run nobody watches doesn't
 * stop to ask. Over it, what this routine's runs wait on the viewer for, with
 * the way to their chats. A change to what the routine does ends these yeses:
 * then it says so, and they can be given again at once. Those who answer for
 * nothing here see nothing, but its maker, who's told who does.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Button, Card, Checkbox, Icon, message, Notice } from "../../../../../hosts/web/mod.ts";
import { agentsShown, originKey } from "../../../../agents/chat/contract.ts";
import type { Routine } from "../../../../agents/routines/contract.ts";
import { nameOf, namesIn } from "../../../../access/spaces/contract.ts";
import type { Approval } from "../../collections/approval.ts";
import type { Desk } from "../../collections/desk.ts";
import type { Grant } from "../../collections/grant.ts";
import { asked } from "./asked.ts";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;
type Work = "terminal" | "jobs" | "writes";

const WORK: { work: Work; label: string }[] = [
  { work: "terminal", label: "Run commands" },
  { work: "jobs", label: "Start jobs" },
  { work: "writes", label: "Change files" },
];

const threadPath = (a: Approval) =>
  `/thread/${encodeURIComponent(a.thread)}${a.in ? `?in=${encodeURIComponent(a.in)}` : ""}`;

export const routinePanelView = (item: Routine, ctx: ViewContext<ReactNode>): ReactNode => {
  const key = originKey({ kind: "routine", id: item._id });
  const desks = ctx.db.collection("desk").query<Desk[]>("here", { in: item.in }).value;
  const grants = ctx.db.collection("grant").query<Grant[]>("forOrigin", { origin: key }).value;
  const pending = ctx.db.collection("approval").query<Approval[]>("pending", {}).value;
  const me = ctx.viewer?.name;
  const owners = (desks ?? []).map((d) => d.owner);
  const names = namesIn(ctx, [...owners]);
  const waiting = (pending ?? []).filter((a) => a.origin && originKey(a.origin) === key);
  const agents = agentsShown(ctx, [item.agent, ...waiting.map((a) => a.agent)]);
  if (!desks || !grants || !pending || !agents) return null;
  const named = (agent: string) => agents[agent]?.name || agent;
  // Whom a computer's asks go to, when this routine runs: its maker, unless its owner keeps that.
  const answererOf = (d: Desk) => d.answers === "owner" ? d.owner : item.by;
  const mine = desks.filter((d) => answererOf(d) === me);
  const others = item.by === me ? desks.filter((d) => answererOf(d) !== me) : [];
  if (!mine.length && !others.length && !waiting.length) return null;
  return (
    <>
      <style href="computers-web" precedence="copilotz">{STYLE}</style>
      <Allowed
        routine={item}
        desks={mine}
        others={others.map((d) => ({
          id: d._id,
          computer: d.name ?? d.computer,
          answers: nameOf(answererOf(d), names),
        }))}
        grants={grants}
        waiting={waiting}
        named={named}
        call={ctx.call}
      />
    </>
  );
};

function Allowed(
  { routine: r, desks, others, grants, waiting, named, call }: {
    routine: Routine;
    desks: Desk[];
    others: { id: string; computer: string; answers: string }[];
    grants: Grant[];
    waiting: Approval[];
    named(agent: string): string;
    call: Call;
  },
): ReactNode {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const rev = r.rev ?? 0;
  const origin = {
    kind: "routine",
    id: r._id,
    name: r.name,
    rev,
    path: `/routine/${encodeURIComponent(r._id)}`,
  };
  const now = grants.filter((g) => g.rev === rev);
  const old = grants.filter((g) => g.rev !== rev);
  const has = (desk: string, agent: string, work: Work) =>
    now.some((g) => g.desk === desk && g.agent === agent && g.work === work);
  // Its own agent on each computer, and any other it has let (an agent its agent asked).
  const rows = [
    ...desks.map((d) => ({ desk: d, agent: r.agent })),
    ...desks.flatMap((d) =>
      [...new Set(now.filter((g) => g.desk === d._id && g.agent !== r.agent).map((g) => g.agent))]
        .map((agent) => ({ desk: d, agent }))
    ),
  ];
  const set = async (work: string, input: Record<string, unknown>[]) => {
    setBusy(work);
    setError(undefined);
    try {
      for (const one of input) await call("computer.allowOrigin", { origin, ...one });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="routine-allowed-wrap">
      {waiting.map((a) => {
        const { wants, what } = asked(a);
        return (
          <Notice
            key={a._id}
            tone="warning"
            title={`A run is waiting on your OK`}
            action={<Button size="sm" icon="chat" href={threadPath(a)}>Answer in its chat</Button>}
          >
            {named(a.agent)} {wants} <code className="routine-allowed-what">{what}</code>
          </Notice>
        );
      })}
      {old.length
        ? (
          <Notice
            tone="warning"
            title="Your OK ended when this routine changed"
            action={
              <Button
                size="sm"
                icon="check"
                loading={busy === "again"}
                onClick={() =>
                  void set(
                    "again",
                    old.map((g) => ({ desk: g.desk, agent: g.agent, work: g.work, allow: true })),
                  )}
              >
                Allow again
              </Button>
            }
          >
            What it asks, or whom, isn't what you said yes to. Until you allow it again, runs stop
            and ask.
          </Notice>
        )
        : null}
      {rows.length || others.length
        ? (
          <Card as="section" className="routine-allowed" aria-labelledby={`allowed-${r._id}`}>
            <h2 id={`allowed-${r._id}`}>
              <Icon name="lock" size={16} /> What it can do without asking
            </h2>
            <p className="routine-allowed-note">
              Runs happen when nobody's watching. What's left unticked stops the run until someone
              answers in its chat. What's ticked runs unchecked, so tick only what you'd trust it
              with. Publishing an app always asks.
            </p>
            {rows.map(({ desk, agent }) => (
              <fieldset key={`${desk._id}:${agent}`} className="routine-allowed-row">
                <legend>
                  {desk.name ?? desk.computer}
                  {agent === r.agent ? null : <small>{named(agent)}</small>}
                </legend>
                <div className="routine-allowed-work">
                  {WORK.filter(({ work }) =>
                    !desk.approve || desk.approve.includes(work)
                  ).map((
                    { work, label },
                  ) => (
                    <Checkbox
                      key={work}
                      label={label}
                      checked={has(desk._id, agent, work)}
                      disabled={!!busy}
                      onChange={(event) =>
                        void set(`${desk._id}:${agent}:${work}`, [{
                          desk: desk._id,
                          agent,
                          work,
                          allow: event.target.checked,
                        }])}
                    />
                  ))}
                </div>
              </fieldset>
            ))}
            {others.map((o) => (
              <p key={o.id} className="routine-allowed-note">
                On {o.computer}, {o.answers} answers: they'll be asked when a run gets there.
              </p>
            ))}
            {error ? <p role="alert" className="ask-error">{error}</p> : null}
          </Card>
        )
        : null}
    </div>
  );
}
