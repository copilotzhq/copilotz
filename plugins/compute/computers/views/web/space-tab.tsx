/**
 * A space's computers (kind `computer.space`: its Computer tab, item
 * `{ _id }`, the space; spaces' `spaceTabs`): those it has (its desks), each
 * a machine of someone's with a folder for this space, and adding one
 * (connecting a computer here, or putting one of yours here); then the one
 * picked (the one agents use, at first) to work on: its terminal, jobs and
 * files in this space's folder (agents' jobs by their names: chat's
 * `thread.agents`). A viewer sees them; those who may write here
 * work on them. In a side panel (`hints.mode: "panel"`), the same, compact,
 * to watch what agents do while you chat.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Notice, Skeleton } from "../../../../../hosts/web/mod.ts";
import type { Reached } from "../../../../access/spaces/contract.ts";
import type { Team } from "../../../../agents/chat/contract.ts";
import type { Computer } from "../../collections/computer.ts";
import type { Desk } from "../../collections/desk.ts";
import { Desks } from "./desks.tsx";
import { type Named, namedOf } from "./names.ts";
import { STYLE } from "./style.ts";
import { Workspace } from "./workspace.tsx";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export const spaceComputersView = (
  item: { _id?: string },
  ctx: ViewContext<ReactNode>,
): ReactNode => {
  const id = item._id ?? (typeof ctx.hints.in === "string" ? ctx.hints.in : "");
  const desks = ctx.db.collection("desk").query<Desk[]>("here", { in: id }).value;
  const mine = ctx.db.collection("computer").query<Computer[]>("mine", {}).value;
  const spaces = ctx.db.collection("space").query<Reached[]>("reached", {}).value;
  // The agents answering here, as they're named: whose its jobs are.
  const team = ctx.db.collection("thread").query<Team>("agents", { in: id }).value;
  const compact = ctx.hints.mode === "panel";
  const style = <style href="computers-web" precedence="copilotz">{STYLE}</style>;
  if (desks === undefined || mine === undefined || spaces === undefined) {
    return (
      <div className="space-computers" aria-busy="true">
        {style}
        <Skeleton height={60} radius="xl" width={compact ? "100%" : 320} />
        <Skeleton height={compact ? 260 : 380} radius="xl" />
      </div>
    );
  }
  const space = spaces.find((s) => s._id === id);
  if (!space) return null;
  return (
    <>
      {style}
      <SpaceComputers
        key={space._id}
        space={space}
        desks={desks}
        mine={mine}
        me={ctx.viewer?.name}
        agents={namedOf(team?.agents)}
        compact={compact}
        call={ctx.call}
      />
    </>
  );
};

/** A desk's computer, as a page about it needs it: the person's own, or what the desk says of it. */
const machineOf = (desk: Desk, mine: Computer[]): Computer =>
  mine.find((c) => c._id === desk.computer) ?? {
    _id: desk.computer,
    owner: desk.owner,
    secret: "",
    online: desk.online,
    at: desk.at,
    ...(desk.name ? { name: desk.name } : {}),
    ...(desk.seen ? { seen: desk.seen } : {}),
    ...(desk.info ? { info: desk.info } : {}),
  };

function SpaceComputers(
  { space, desks, mine, me, agents, compact, call }: {
    space: Reached;
    desks: Desk[];
    mine: Computer[];
    me?: string;
    agents: Record<string, Named>;
    compact: boolean;
    call: Call;
  },
): ReactNode {
  const [picked, setPicked] = useState<string>();
  // The one picked while it's here; else the one agents use (the query lists it first).
  const desk = desks.find((d) => d._id === picked) ?? desks[0];
  const write = space.can.includes("write");
  return (
    <div className={`space-computers${compact ? " space-computers-compact" : ""}`}>
      <Desks
        space={space}
        desks={desks}
        mine={mine}
        chosen={desk?._id}
        choose={setPicked}
        me={me}
        call={call}
        compact={compact}
      />
      {desk && write
        ? (
          <Workspace
            key={desk._id}
            computer={machineOf(desk, mine)}
            spaces={[space]}
            desks={[desk]}
            here={space._id}
            me={me}
            agents={agents}
            call={call}
            fixed
            compact={compact}
            {...(desk.owner === me ? {} : { theirs: desk.owner })}
          />
        )
        : desk
        ? (
          <Notice tone="neutral" icon="lock">
            You can see {space.name}'s computers; its editors work on them.
          </Notice>
        )
        : null}
    </div>
  );
}
