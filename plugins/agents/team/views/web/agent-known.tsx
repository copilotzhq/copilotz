/**
 * Agents someone has met, to add to a space: those that don't work there
 * yet (the app's, and those people made where the person reaches), each by
 * its emoji and names, what it does or where it belongs; found as they're
 * typed; each added at once, in the role chosen for them (`member.set`),
 * which says so. First in the list, making a new one instead.
 */
import { type ReactNode, useId, useState } from "react";
import { Avatar, Button, Icon, Input, message, Select } from "../../../../../hosts/web/mod.ts";
import { AGENT_ROLES } from "../../../../access/spaces/contract.ts";
import type { Agent } from "../../../chat/contract.ts";
import { found, listed, shownAs } from "./agents.ts";
import { type Place, placeName } from "./places.ts";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** Past this many, there's a field to find one. */
const FIND = 5;

/** Where an agent comes from, in a few words. */
export const belongs = (agent: Agent, places: Place[]) => {
  if (!agent.in) return say("oneOfApps");
  const home = places.find((p) => p._id === agent.in);
  return home ? say("madeIn", { place: placeName(home) }) : say("madeInOther");
};

export function KnownAgents(
  { space, agents, places, call, onNew }: {
    space: Place;
    /** The agents they've met that don't work here, by id. */
    agents: [string, Agent][];
    places: Place[];
    call: Call;
    onNew(): void;
  },
): ReactNode {
  const id = useId();
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("editor");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [added, setAdded] = useState<string[]>([]);
  const all = agents.map(([key, agent]) => ({ id: key, ...shownAs(key, agent), agent }));
  const shown = found(all, search);
  const where = placeName(space);
  const add = async (agent: string, name: string) => {
    setBusy(agent);
    setError(undefined);
    try {
      await call("member.set", { space: space._id, member: { kind: "agent", id: agent }, role });
      setAdded((now) => [...now, name]);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="agent-known">
      <div className="agent-known-tools">
        {agents.length > FIND
          ? (
            <>
              <label className="copilotz-sr" htmlFor={`${id}-find`}>{say("findAgent")}</label>
              <Input
                id={`${id}-find`}
                type="search"
                icon="search"
                size="sm"
                className="agent-known-find"
                placeholder={say("findAgentKnown")}
                autoComplete="off"
                autoFocus
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </>
          )
          : <p className="agent-known-intro">{say("knownIntro")}</p>}
        <label className="agent-known-role">
          <span>{say("addsAs")}</span>
          <Select size="sm" value={role} onChange={(event) => setRole(event.target.value)}>
            {AGENT_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </Select>
        </label>
      </div>
      <ul className="agent-known-list">
        <li>
          <button type="button" className="agent-known-row agent-known-new" onClick={onNew}>
            <span className="agent-known-plus">
              <Icon name="plus" size={18} />
            </span>
            <span className="agent-known-text">
              <span className="agent-known-name">{say("createNewAgent")}</span>
              <span className="agent-known-what">
                {say("createNewAgentBody")}
              </span>
            </span>
            <Icon name="chevron" size={16} />
          </button>
        </li>
        {shown.map((a) => (
          <li key={a.id} className="agent-known-row">
            <Avatar name={a.name} kind="agent" icon={a.icon} size={34} />
            <span className="agent-known-text">
              <span className="agent-known-name">
                {a.name} <span className="agent-handle">@{a.id}</span>
                <span className="agent-known-from">{belongs(a.agent, places)}</span>
              </span>
              {a.agent.description
                ? <span className="agent-known-what">{a.agent.description}</span>
                : null}
            </span>
            <Button
              size="sm"
              icon="plus"
              loading={busy === a.id}
              disabled={!!busy && busy !== a.id}
              aria-label={say("addAgentTo", { name: a.name, place: where })}
              onClick={() => void add(a.id, a.name)}
            >
              {say("add")}
            </Button>
          </li>
        ))}
      </ul>
      {!shown.length
        ? (
          <p className="agent-known-none">
            {agents.length
              ? say("noneCalled", { search: search.trim() })
              : say("allWorkHere", { place: where })}
          </p>
        )
        : null}
      <p className="agent-form-note" aria-live="polite">
        {error
          ? <span className="agent-error" role="alert">{error}</span>
          : added.length
          ? (
            <span className="agent-done">
              <Icon name="check" size={14} />
              {say("worksNowNames", { names: listed(added), place: where, count: added.length })}
            </span>
          )
          : AGENT_ROLES.find((r) => r.value === role)?.lets}
      </p>
    </div>
  );
}
