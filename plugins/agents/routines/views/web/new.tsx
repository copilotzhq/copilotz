/**
 * A new routine in a space: the form, starting from what's usual (every
 * weekday at nine, where the person is; the agent that answers new chats
 * there), or from an example. In a dialog of the tab's own, or the command
 * palette's (kind `routine.new`, item `{ _id }`, the space).
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { go, Notice, Skeleton } from "../../../../../hosts/web/mod.ts";
import type { Team } from "../../../chat/contract.ts";
import { localZone } from "../../shared/schedule.ts";
import { type Pickable, RoutineForm } from "./form.tsx";
import { type Example, picking, routinePath } from "./routines.ts";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** The agents answering in a space, as the form picks them. */
export const pickable = (team: Team): Pickable[] =>
  team.here.map((id) => ({
    id,
    name: team.agents[id]?.name || id,
    ...(team.agents[id]?.icon ? { icon: team.agents[id].icon } : {}),
  }));

export function NewRoutine(
  { space, team, example, call, done }: {
    space: string;
    team: Team;
    example?: Example;
    call: Call;
    done(routine: string): void;
  },
): ReactNode {
  const zone = localZone();
  const agents = pickable(team);
  return (
    <RoutineForm
      space={space}
      was={{
        name: example?.name ?? "",
        text: example?.text ?? "",
        agent: team.default.find((a) => team.here.includes(a)) ?? agents[0]?.id ?? "",
        post: "same",
      }}
      when={{ ...picking(zone), ...example?.when }}
      agents={agents}
      call={call}
      done={done}
    />
  );
}

/** The command palette's dialog: a new routine where the person is. */
export const newRoutineView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const space = item._id ?? (typeof ctx.hints.in === "string" ? ctx.hints.in : "");
  const team = ctx.db.collection("thread").query<Team>("agents", { in: space }).value;
  const style = <style href="routines-web" precedence="copilotz">{STYLE}</style>;
  if (!team) return <Skeleton height={360} radius="xl" />;
  if (!team.here.length) {
    return <Notice tone="neutral">No agent answers in this space yet: add one first.</Notice>;
  }
  return (
    <>
      {style}
      <NewRoutine
        space={space}
        team={team}
        call={ctx.call}
        done={(routine) => {
          document.querySelector<HTMLDialogElement>("dialog[open]")?.close();
          go(routinePath(routine));
        }}
      />
    </>
  );
};
