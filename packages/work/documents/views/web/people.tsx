/**
 * Who's who on the web, for documents: people and agents from their keys
 * (`person:ana`, `agent:north`), each as it shows (a person by their
 * profile's name, an agent by its name and emoji, as chat's `thread.agents`
 * says), their
 * faces, the spaces as they're named, and a clock that ticks on its own
 * for what goes stale (who's here).
 */
import { type ReactNode, useEffect, useState } from "react";
import type { ViewContext } from "copilotz";
import { namesIn } from "copilotz/plugins/access/contract";
import type { Agent, Team } from "copilotz/plugins/agents/contract";
import { Avatar } from "copilotz/web";
import { personName, whoOf } from "../../shared/who.ts";

export type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** A space as `space.reached` answers. */
export type Place = {
  _id: string;
  name: string;
  kind: string;
  owner?: string;
  can?: string[];
  archived?: string;
};

/** What a space is called where it shows: yours is "Personal". */
export const placeName = (p: Pick<Place, "name" | "kind">) =>
  p.kind === "personal" ? "Personal" : p.name;

/** Whether the person may change what's in a space. */
export const writes = (p?: Place) => !!p?.can?.includes("write") && !p.archived;

/** Someone, as a page shows them. */
export type Shown = { key: string; kind: string; id: string; name: string; icon?: string };

/** Who keys are: each agent's name and emoji (as chat says), each person's name (their profile). */
export type Known = { agents: Record<string, Agent>; names: Record<string, string> };

/** Who's among `keys`, as they show; nothing yet while it reads. */
export function whoIn(ctx: ViewContext<ReactNode>, keys: (string | undefined)[]): Known {
  const of = (kind: string) =>
    [...new Set(keys.flatMap((k) => k && whoOf(k).kind === kind ? [whoOf(k).id] : []))].sort();
  const agents = of("agent");
  return {
    agents: agents.length
      ? ctx.db.collection("thread").query<Team>("agents", { names: agents }).value?.agents ?? {}
      : {},
    names: namesIn(ctx, of("person")),
  };
}

/** Someone by key, as they show: a person by name, an agent as it's named. */
export function shownAs(key: string, known: Partial<Known> = {}): Shown {
  const who = whoOf(key);
  const agent = who.kind === "agent" ? known.agents?.[who.id] : undefined;
  return {
    key,
    kind: who.kind,
    id: who.id,
    name: who.kind === "agent" ? agent?.name || who.id : personName(who.id, known.names),
    ...(agent?.icon ? { icon: agent.icon } : {}),
  };
}

/** Their face: a person's initial, an agent's emoji (or initial) on its tile. */
export function Face({ who, size = 22 }: { who: Shown; size?: number }): ReactNode {
  return who.kind === "agent"
    ? <Avatar name={who.name} kind="agent" icon={who.icon} size={size} />
    : <Avatar name={who.name} size={size} />;
}

/** Someone's name in a sentence: "You" (or "you") for the viewer. */
export const said = (who: Shown, me?: string, start = true) =>
  who.kind === "person" && who.id === me ? (start ? "You" : "you") : who.name;

/** The time now, again every `ms`: for what goes stale on its own. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** The key that goes with shortcuts: ⌘ on Apple's, Ctrl elsewhere. */
export const MOD = /Mac|iP(hone|ad|od)/.test(globalThis.navigator?.platform ?? "") ? "⌘" : "Ctrl";

/** Whether a key event has the shortcut key (⌘ on Apple's, Ctrl elsewhere). */
export const modded = (event: { metaKey: boolean; ctrlKey: boolean }) =>
  MOD === "⌘" ? event.metaKey : event.ctrlKey;

/** "1 version", "4 versions". */
export const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;
