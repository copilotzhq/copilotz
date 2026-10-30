/**
 * A space's agents, in its Members tab: each by its emoji (or initial), the
 * name it's shown as and the one it's called by (`@maya`), what it does or
 * where it belongs, and its role; the one answering new chats says so,
 * first. Each links to its page (`/agent/<id>`). Those who manage the space
 * change an agent's role, have it answer new chats, open it to edit (when
 * they manage where it belongs; otherwise to view), take it out, and add
 * one (the invite surface, at Agents). What agents are, said in a line.
 */
import { type ReactNode, useState } from "react";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Menu,
  type MenuItem,
  message,
  Select,
} from "../../../../../hosts/web/mod.ts";
import type { Member, Reached } from "../../contract.ts";
import { AGENT_ROLES, roleName, spaceName, whoOf } from "./who.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** What chat's `thread.agents` says of an agent: what it's shown as, does, and where it belongs. */
export type AgentShown = { name?: string; icon?: string; description?: string; in?: string };

/** Who answers in a space, as `thread.agents` says, and what each agent asked about is. */
export type Roster = { here: string[]; default: string[]; agents: Record<string, AgentShown> };

const pageOf = (id: string, edit = false) =>
  `/agent/${encodeURIComponent(id)}${edit ? "?edit=1" : ""}`;

export function Agents(
  { space, spaces, members, roster, manage, adds, onAdd, call }: {
    space: Reached;
    /** Every space the person reaches: where each agent belongs, and whether they manage it. */
    spaces: Reached[];
    /** The space's agent members. */
    members: Member[];
    roster?: Roster;
    manage: boolean;
    /** Whether agents can be added here (the app has them). */
    adds: boolean;
    onAdd(): void;
    call: Call;
  },
): ReactNode {
  const personal = space.kind === "personal";
  const answers = roster?.default[0];
  const shown = (id: string) => roster?.agents[id];
  const name = (id: string) => shown(id)?.name || id;
  const sorted = [...members].sort((a, b) => {
    const x = whoOf(a.member).id;
    const y = whoOf(b.member).id;
    return Number(y === answers) - Number(x === answers) ||
      name(x).localeCompare(name(y), undefined, { sensitivity: "base" });
  });
  if (!members.length && !adds) return null;
  return (
    <section className="space-section" aria-labelledby="space-agents">
      <div className="space-section-head">
        <h3 id="space-agents" className="space-section-title">
          Agents <span className="space-count">{members.length}</span>
        </h3>
        {manage && adds && !space.archived
          ? (
            <Button size="sm" variant="ghost" icon="plus" onClick={onAdd}>
              Add an agent
            </Button>
          )
          : null}
      </div>
      <p className="space-section-about">
        {personal
          ? "They work here for you. One answers new chats; @name asks another."
          : "They work for whoever asks them, and reach only what that person can. One answers " +
            "new chats; @name asks another."}
      </p>
      {members.length
        ? (
          <ul className="space-rows">
            {sorted.map((m) => {
              const id = whoOf(m.member).id;
              const home = shown(id)?.in;
              const edits = !!home && !!spaces.find((s) => s._id === home)?.can.includes("manage");
              return (
                <AgentRow
                  key={m._id}
                  member={m}
                  id={id}
                  agent={shown(id)}
                  home={home ? spaces.find((s) => s._id === home) : undefined}
                  answers={id === answers}
                  space={space}
                  manage={manage}
                  edits={edits}
                  call={call}
                />
              );
            })}
          </ul>
        )
        : (
          <Card className="space-agents-none">
            <p>No agent works here yet: chats here have no one to answer them.</p>
            {manage && !space.archived
              ? (
                <Button size="sm" variant="primary" icon="plus" onClick={onAdd}>
                  Add an agent
                </Button>
              )
              : null}
          </Card>
        )}
    </section>
  );
}

/** One agent working here: who it is, its role, and what a manager does with it. */
function AgentRow(
  { member: m, id, agent, home, answers, space, manage, edits, call }: {
    member: Member;
    id: string;
    agent?: AgentShown;
    /** The space it belongs to, if the person reaches it. */
    home?: Reached;
    answers: boolean;
    space: Reached;
    manage: boolean;
    /** Whether the person changes it: they manage where it belongs. */
    edits: boolean;
    call: Call;
  },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const name = agent?.name || id;
  const act = async (action: string, input: Record<string, unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await call(action, input);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const member = { space: space._id, member: { kind: "agent", id } };
  const what = agent?.description ||
    (agent?.in
      ? home ? `Made in ${spaceName(home)}` : "Made in another space"
      : agent
      ? "One of the app's agents"
      : "An agent");
  const items: (MenuItem | "separator")[] = [
    ...(!answers && m.role === "editor"
      ? [{
        label: "Make it answer new chats",
        icon: "chat" as const,
        onSelect: () => void act("space.agent", { space: space._id, agent: id }),
      }]
      : []),
    edits
      ? { label: `Edit ${name}`, icon: "pencil", href: pageOf(id, true) }
      : { label: `View ${name}`, icon: "bot", href: pageOf(id) },
    "separator",
    {
      label: "Remove from this space",
      icon: "close",
      tone: "destructive",
      onSelect: () => void act("member.remove", member),
    },
  ];
  return (
    <Card
      as="li"
      padding="none"
      className="space-row space-row-agent"
      aria-busy={busy || undefined}
    >
      <a className="space-row-face" href={pageOf(id)} tabIndex={-1} aria-hidden="true">
        <Avatar name={name} kind="agent" icon={agent?.icon} size={32} />
      </a>
      <div className="space-row-text">
        <p className="space-row-name">
          <a className="space-row-link" href={pageOf(id)}>{name}</a>
          <span className="space-row-handle">@{id}</span>
          {answers ? <Badge tone="primary">Answers new chats</Badge> : null}
        </p>
        <p className="space-row-what">
          {error ? <span className="space-invite-error">{error}</span> : what}
        </p>
      </div>
      <div className="space-row-end">
        {manage
          ? (
            <>
              <Select
                size="sm"
                value={m.role}
                disabled={busy}
                aria-label={`${name}'s role`}
                onChange={(event) =>
                  void act("member.set", { ...member, role: event.target.value })}
              >
                {AGENT_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                {AGENT_ROLES.some((r) => r.value === m.role)
                  ? null
                  : <option value={m.role}>{roleName(m.role)}</option>}
              </Select>
              <Menu label={`${name}: more`} align="end" size="sm" items={items} />
            </>
          )
          : <Badge variant="outline">{roleName(m.role)}</Badge>}
      </div>
    </Card>
  );
}
