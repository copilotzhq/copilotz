/**
 * Adding an agent to a space (kind `agent.add`, item `{ _id }`, the space;
 * hints `{ in, mode?, from? }`): the Agents tab of spaces' invite surface
 * (the `spaceInvite` resource), and the command palette's "Add an agent"
 * and "New agent". One the person has met that doesn't work there yet
 * (`KnownAgents`), or a new one made there (`NewAgent`: at once when `mode`
 * is "new", or when there's none to add; `from`, one of the app's agents to
 * start from). For those who manage the space, while it's in use.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Notice, Skeleton } from "../../../../../hosts/web/mod.ts";
import type { Agent, Team } from "../../../chat/contract.ts";
import { KnownAgents } from "./agent-known.tsx";
import { NewAgent } from "./agent-new.tsx";
import type { Options } from "./agents.ts";
import { manages, type Place, placeName } from "./places.ts";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export const agentAddView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const id = item._id ?? (typeof ctx.hints.in === "string" ? ctx.hints.in : "");
  const places = ctx.db.collection("space").query<Place[]>("reached", {}).value;
  const known = ctx.db.collection("agent").query<Record<string, Agent>>("known", {}).value;
  const here = ctx.db.collection("thread").query<Team>("agents", { in: id }).value;
  const options = ctx.db.collection("agent").query<Options>("options", {}).value;
  const style = <style href="team-web" precedence="copilotz">{STYLE}</style>;
  if (!places || !known || !here || !options) {
    return (
      <div className="agent-add" aria-busy="true">
        {style}
        <Skeleton height={56} radius="lg" />
        <Skeleton height={56} radius="lg" />
      </div>
    );
  }
  const space = places.find((p) => p._id === id);
  if (!space || !manages(space) || space.archived) {
    return (
      <Notice tone="neutral" icon="lock">
        {!space
          ? "This space isn't one of yours."
          : space.archived
          ? `${placeName(space)} is archived: restore it to add agents.`
          : `Those who manage ${placeName(space)} add agents to it.`}
      </Notice>
    );
  }
  // Those they've met that don't work here yet: the app's first, then by name.
  const others = Object.entries(known).filter(([key]) => !here.here.includes(key))
    .sort(([a, x], [b, y]) =>
      Number(!!x.in) - Number(!!y.in) ||
      (x.name || a).localeCompare(y.name || b, undefined, { sensitivity: "base" })
    );
  const from = typeof ctx.hints.from === "string" ? ctx.hints.from : undefined;
  return (
    <>
      {style}
      <AddAgent
        space={space}
        places={places}
        known={known}
        others={others}
        options={options}
        first={ctx.hints.mode === "new" || from || !others.length ? "new" : "known"}
        from={from}
        call={ctx.call}
      />
    </>
  );
};

function AddAgent(
  { space, places, known, others, options, first, from, call }: {
    space: Place;
    places: Place[];
    known: Record<string, Agent>;
    others: [string, Agent][];
    options: Options;
    first: "known" | "new";
    from?: string;
    call: Call;
  },
): ReactNode {
  const [mode, setMode] = useState(first);
  return (
    <div className="agent-add">
      {mode === "known"
        ? (
          <KnownAgents
            space={space}
            agents={others}
            places={places}
            call={call}
            onNew={() => setMode("new")}
          />
        )
        : (
          <NewAgent
            space={space}
            known={known}
            options={options}
            call={call}
            from={from}
            onBack={others.length ? () => setMode("known") : undefined}
          />
        )}
    </div>
  );
}
