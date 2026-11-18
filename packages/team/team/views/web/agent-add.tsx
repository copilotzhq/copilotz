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
import type { ViewContext } from "copilotz";
import { Notice, Skeleton } from "copilotz/web";
import type { Agent, Team } from "copilotz/plugins/agents/contract";
import { KnownAgents } from "./agent-known.tsx";
import { NewAgent } from "./agent-new.tsx";
import type { Options } from "./agents.ts";
import { manages, type Place, placeName } from "./places.ts";
import { STYLE } from "./style.ts";
import type { KindOption } from "./agent-describe.tsx";

/** A kind of work as the tiers' `modelChoice.offered` answers it. */
type KindShown = { kind: string; title: string; agents: { name: string }[] };
import { sayText } from "copilotz/web/words";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export const agentAddView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const id = item._id ?? (typeof ctx.hints.in === "string" ? ctx.hints.in : "");
  const places = ctx.db.collection("space").query<Place[]>("reached", {}).value;
  const known = ctx.db.collection("agent").query<Record<string, Agent>>("known", {}).value;
  const here = ctx.db.collection("thread").query<Team>("agents", { in: id }).value;
  const options = ctx.db.collection("agent").query<Options>("options", {}).value;
  // Kinds of work, where tiers give agents their models (their front end says so: `agentKinds`).
  const kindsAsked = !!(ctx.resources.agentKinds as { query?: string } | undefined)?.query;
  const tiers = kindsAsked
    ? ctx.db.collection("modelChoice").query<{ kinds: KindShown[] }>("offered", {}).value
    : undefined;
  const style = <style href="team-web" precedence="copilotz">{STYLE}</style>;
  if (!places || !known || !here || !options || (kindsAsked && !tiers)) {
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
          ? say("notYourSpace")
          : space.archived
          ? say("archivedSpace", { place: placeName(space) })
          : say("managersAdd", { place: placeName(space) })}
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
        kinds={tiers?.kinds.map((k) => ({
          kind: k.kind,
          title: sayText(k.title),
          agents: k.agents.map((a) => a.name),
        }))}
        call={ctx.call}
      />
    </>
  );
};

function AddAgent(
  { space, places, known, others, options, first, from, kinds, call }: {
    space: Place;
    places: Place[];
    known: Record<string, Agent>;
    others: [string, Agent][];
    options: Options;
    first: "known" | "new";
    from?: string;
    kinds?: KindOption[];
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
            kinds={kinds}
            onBack={others.length ? () => setMode("known") : undefined}
          />
        )}
    </div>
  );
}
