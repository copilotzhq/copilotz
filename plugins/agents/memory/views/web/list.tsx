/**
 * Memories grouped by whom they're about (you first, then other people,
 * agents, by their names and emoji, everyone, particular chats), with a
 * search and a way to see core ones alone; compact in a side panel. Nothing remembered yet, it says what
 * will be, and offers a chat (`fresh`: where one starts).
 */
import { type ReactNode, useId, useState } from "react";
import { Avatar, Button, EmptyState, Icon, Input, Tabs } from "../../../../../hosts/web/mod.ts";
import type { Memory } from "../../collections/memory.ts";
import { MemoryCard } from "./card.tsx";
import { nameOf, withNames } from "../../../../access/spaces/contract.ts";

type Group = { key: string; label: string; avatar: ReactNode; rank: number; items: Memory[] };

/** An agent as it's named, with its emoji. */
export type Named = { name: string; icon?: string };

/** Whom a memory is about, as a heading says it, and where its group goes. */
function groupOf(
  about: string,
  me?: string,
  agents: Record<string, Named> = {},
  names: Record<string, string> = {},
): Omit<Group, "items"> {
  const at = about.indexOf(":");
  const [kind, name] = at < 0 ? [about, ""] : [about.slice(0, at), about.slice(at + 1)];
  if (kind === "person") {
    const person = nameOf(name, names);
    return name === me
      ? { key: about, label: "About you", avatar: <Avatar name={person} size={26} />, rank: 0 }
      : {
        key: about,
        label: `About ${person}`,
        avatar: <Avatar name={person} size={26} />,
        rank: 1,
      };
  }
  if (kind === "agent") {
    const agent = agents[name];
    return {
      key: about,
      label: `About ${agent?.name ?? name}`,
      avatar: <Avatar name={agent?.name ?? name} kind="agent" icon={agent?.icon} size={26} />,
      rank: 2,
    };
  }
  if (kind === "thread") {
    return {
      key: "thread",
      label: "About particular chats",
      avatar: (
        <span className="mem-group-icon">
          <Icon name="chat" size={14} />
        </span>
      ),
      rank: 4,
    };
  }
  return {
    key: about,
    label: "About everyone",
    avatar: (
      <span className="mem-group-icon">
        <Icon name="sparkles" size={14} />
      </span>
    ),
    rank: 3,
  };
}

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export function MemoryList(
  { memories, spaces, agents = {}, names = {}, me, fresh = "/", compact, call }: {
    memories: Memory[];
    /** Spaces' names, to say where each was learned (none: they're all from one). */
    spaces: Record<string, string>;
    /** Agents they're about or by, as each is named. */
    agents?: Record<string, Named>;
    /** People by name (`namesIn`): whom they're about, who wrote them, whom they name. */
    names?: Record<string, string>;
    me?: string;
    fresh?: string;
    compact?: boolean;
    call: Call;
  },
): ReactNode {
  const [search, setSearch] = useState("");
  const [which, setWhich] = useState<"all" | "core">("all");
  const core = which === "core";
  const id = useId();
  if (!memories.length) {
    return (
      <EmptyState
        icon="sparkles"
        tone="primary"
        title="Nothing remembered yet"
        className="mem-empty"
        action={
          <Button variant="primary" icon="compose" href={fresh}>
            Start a chat
          </Button>
        }
      >
        As you talk, agents keep here what will matter later: who you are, what you prefer, what you
        decided.
      </EmptyState>
    );
  }
  const words = search.trim().toLowerCase();
  // What they say, whom about and by whom, as they show (people by name).
  const said = (m: Memory) =>
    [
      withNames(m.text, names),
      groupOf(m.about, me, agents, names).label,
      agents[m.by]?.name ?? nameOf(m.by, names),
    ].join(" ").toLowerCase();
  const shown = memories.filter((m) => (!core || m.core) && (!words || said(m).includes(words)));
  const groups = new Map<string, Group>();
  for (const m of shown) {
    const of = groupOf(m.about, me, agents, names);
    if (!groups.has(of.key)) groups.set(of.key, { ...of, items: [] });
    groups.get(of.key)!.items.push(m);
  }
  const sorted = [...groups.values()].sort((a, b) =>
    a.rank - b.rank || a.label.localeCompare(b.label)
  );
  const cores = memories.filter((m) => m.core).length;
  return (
    <div className={`mem-body${compact ? " mem-body-compact" : ""}`}>
      <div className="mem-tools">
        <Input
          icon="search"
          type="search"
          size={compact ? "sm" : "md"}
          className="mem-search"
          aria-label="Search memories"
          value={search}
          placeholder="Search memories"
          autoComplete="off"
          onChange={(event) => setSearch(event.target.value)}
        />
        <Tabs
          label="Which memories"
          value={which}
          onChange={setWhich}
          panel={`${id}-shown`}
          tabs={[
            { value: "all", label: "All", count: memories.length },
            {
              value: "core",
              label: (
                <>
                  <span className="mem-star" aria-hidden="true">★</span> Core
                </>
              ),
              count: cores,
            },
          ]}
        />
      </div>
      <div id={`${id}-shown`} role="tabpanel" aria-label={core ? "Core memories" : "All memories"}>
        {sorted.length
          ? sorted.map((g) => (
            <section key={g.key} className="mem-group" aria-labelledby={`${id}-${g.key}`}>
              <h2 id={`${id}-${g.key}`}>
                {g.avatar}
                {g.label}
                <span className="mem-count">{g.items.length}</span>
              </h2>
              <ul className="mem-list">
                {g.items.map((m) => (
                  <MemoryCard
                    key={m._id}
                    memory={m}
                    by={agents[m.by]?.name ?? (m.by === "memory" ? undefined : nameOf(m.by, names))}
                    names={names}
                    space={m.in ? spaces[m.in] : undefined}
                    call={call}
                  />
                ))}
              </ul>
            </section>
          ))
          : (
            <p className="mem-none">
              {words ? `No memories match “${search.trim()}”.` : "No core memories yet."}
            </p>
          )}
      </div>
    </div>
  );
}
