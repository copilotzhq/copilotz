/**
 * A space's members (kind `space.members`, its Members tab): who's in it, by
 * kind, each with their role: its people (you at the top), with those
 * invited and not joined yet under them; its agents (as chat's `thread.agents`
 * shows them: see agents.tsx); and the spaces that draw on it. Those who
 * manage it invite people, take an invitation back, change roles, take
 * someone out (never its last manager), let in or turn down who asked to
 * join, and add agents (the invite surface, at Agents). A Personal space is
 * just you and your agents, and says how to work with others; an archived
 * one invites no one.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Avatar,
  Badge,
  Button,
  Card,
  IconButton,
  message,
  Notice,
  Select,
  Skeleton,
  Time,
} from "../../../../../hosts/web/mod.ts";
import type { Invitation, Member, Reached, Request } from "../../contract.ts";
import { Agents, type Roster } from "./agents.tsx";
import { InviteDialog } from "./invite-dialog.tsx";
import { InviteForm } from "./invite.tsx";
import { Pending } from "./pending.tsx";
import { STYLE } from "./style.ts";
import { kindsOf } from "./tabs.ts";
import { byKind, byMember, lastManager, roleName, ROLES, type Who, whoOf } from "./who.ts";
import { namesIn } from "../../shared/names.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export const membersView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const id = item._id ?? "";
  const spaces = ctx.db.collection("space").query<Reached[]>("reached", {}).value;
  const members = ctx.db.collection<Member>("member").find({ space: id }).value;
  const requests = ctx.db.collection<Request>("request").find({ space: id }, { sort: { at: 1 } })
    .value ?? [];
  const style = <style href="spaces-web" precedence="copilotz">{STYLE}</style>;
  const compact = ctx.hints.mode === "panel";
  if (spaces === undefined || members === undefined) {
    return (
      <div className="space-members" aria-busy="true">
        {style}
        {[0, 1, 2].map((i) => <Skeleton key={i} height={52} radius="lg" />)}
      </div>
    );
  }
  const space = spaces.find((s) => s._id === id);
  if (!space) return null;
  // Only those who manage it read its invitations (the rules say so too).
  const invitations = space.can.includes("manage")
    ? ctx.db.collection<Invitation>("invitation").find({ space: id }, { sort: { at: -1 } })
      .value ?? []
    : [];
  // People by name: members, who asked to join (and for whom), who invited whom.
  const names = namesIn(ctx, [
    ...members.map((m) => m.member),
    ...requests.flatMap((r) => [r.member, ...(r.by ? [r.by] : [])]),
    ...invitations.map((i) => i.by),
  ]);
  // Agents can be added where the app has them (chat adds the invite surface's Agents).
  const adds = kindsOf(ctx.resources.spaceInvite, space.kind === "personal")
    .some((k) => k.key === "agents");
  // What each agent here is, as chat says (only when there are agents, or can be).
  const roster = adds || byKind(members).agents.length
    ? ctx.db.collection("thread").query<Roster>("agents", { in: id }).value
    : undefined;
  return (
    <>
      {style}
      <Members
        space={space}
        spaces={spaces}
        members={byMember(members, ctx.viewer?.name, names)}
        roster={roster}
        adds={adds}
        requests={requests}
        invitations={invitations}
        me={ctx.viewer?.name}
        compact={compact}
        call={ctx.call}
        names={names}
      />
    </>
  );
};

function Members(
  {
    space,
    spaces: reached,
    members,
    roster,
    adds,
    requests,
    invitations,
    me,
    compact,
    call,
    names,
  }: {
    space: Reached;
    spaces: Reached[];
    members: Member[];
    roster?: Roster;
    adds: boolean;
    requests: Request[];
    invitations: Invitation[];
    me?: string;
    compact: boolean;
    call: Call;
    names: Record<string, string>;
  },
): ReactNode {
  const [adding, setAdding] = useState(false);
  const personal = space.kind === "personal";
  const manage = space.can.includes("manage");
  const { people, agents, spaces } = byKind(members);
  const rows = (list: Member[]) =>
    list.map((m) => (
      <Row
        key={m._id}
        member={m}
        space={space}
        me={me}
        manage={manage && !personal}
        last={lastManager(members, m.member)}
        call={call}
        names={names}
      />
    ));
  return (
    <div className={`space-members${compact ? " space-members-compact" : ""}`}>
      {personal
        ? (
          <Notice tone="neutral" icon="person">
            Personal is yours alone: you, and the agents that work for you. To work with others,
            make a shared space (New space, in the sidebar) and invite them there.
          </Notice>
        )
        : null}
      {!personal && manage && requests.length
        ? (
          <section className="space-section" aria-labelledby="space-requests">
            <h3 id="space-requests" className="space-section-title">
              Waiting to join <Badge tone="warning">{requests.length}</Badge>
            </h3>
            <ul className="space-rows">
              {requests.map((r) => <Asking key={r._id} request={r} call={call} names={names} />)}
            </ul>
          </section>
        )
        : null}
      {!personal && manage && !space.archived
        ? (
          <section className="space-section" aria-labelledby="space-invite">
            <h3 id="space-invite" className="space-section-title">Invite people</h3>
            <InviteForm space={space} call={call} compact={compact} />
          </section>
        )
        : null}
      <section className="space-section" aria-labelledby="space-people">
        <h3 id="space-people" className="space-section-title">
          People <span className="space-count">{people.length}</span>
        </h3>
        <ul className="space-rows">{rows(people)}</ul>
      </section>
      {!personal && manage
        ? <Pending invitations={invitations} me={me} call={call} names={names} />
        : null}
      <Agents
        space={space}
        spaces={reached}
        members={agents}
        roster={roster}
        manage={manage}
        adds={adds}
        onAdd={() => setAdding(true)}
        call={call}
      />
      {spaces.length
        ? (
          <section className="space-section" aria-labelledby="space-drawing">
            <h3 id="space-drawing" className="space-section-title">
              Spaces drawing on it <span className="space-count">{spaces.length}</span>
            </h3>
            <ul className="space-rows">{rows(spaces)}</ul>
          </section>
        )
        : null}
      {manage && adds
        ? (
          <InviteDialog
            open={adding}
            onClose={() => setAdding(false)}
            space={space}
            tab="agents"
          />
        )
        : null}
    </div>
  );
}

/** How someone shows in the list: their face. */
function Face({ who }: { who: Who }): ReactNode {
  return <Avatar name={who.name} kind={who.kind === "space" ? "space" : "person"} size={32} />;
}

const whatOf = (who: Who) =>
  who.kind === "space" ? "A space whose members are in this one" : "Person";

function Row(
  { member: m, space, me, manage, last, call, names }: {
    member: Member;
    space: Reached;
    me?: string;
    manage: boolean;
    last: boolean;
    call: Call;
    names: Record<string, string>;
  },
): ReactNode {
  const who = whoOf(m.member, names);
  const mine = who.kind === "person" && who.id === me;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const act = async (action: string, input: Record<string, unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await call(action, { space: space._id, member: { kind: who.kind, id: who.id }, ...input });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card as="li" padding="none" className="space-row">
      <Face who={who} />
      <div className="space-row-text">
        <p className="space-row-name">
          {who.name}
          {mine ? <Badge tone="primary">You</Badge> : null}
        </p>
        <p className="space-row-what">{error ?? whatOf(who)}</p>
      </div>
      <div className="space-row-end">
        {manage && !(mine && last)
          ? (
            <Select
              size="sm"
              value={m.role}
              disabled={busy}
              aria-label={`${who.name}'s role`}
              onChange={(event) => void act("member.set", { role: event.target.value })}
            >
              {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </Select>
          )
          : space.kind === "personal"
          ? null
          : <Badge variant="outline">{roleName(m.role)}</Badge>}
        {manage && !last
          ? (
            <IconButton
              icon="close"
              label={mine ? "Leave this space" : `Take ${who.name} out`}
              size="sm"
              loading={busy}
              onClick={() => void act("member.remove", {})}
            />
          )
          : null}
      </div>
    </Card>
  );
}

/** Someone who asked to join, and why: let them in (with a role) or turn them down. */
function Asking(
  { request: r, call, names }: { request: Request; call: Call; names: Record<string, string> },
): ReactNode {
  const who = whoOf(r.member, names);
  const [role, setRole] = useState("viewer");
  const [busy, setBusy] = useState<"grant" | "deny">();
  const [error, setError] = useState<string>();
  const decide = async (how: "grant" | "deny") => {
    setBusy(how);
    setError(undefined);
    try {
      await call(`request.${how}`, how === "grant" ? { id: r._id, role } : { id: r._id });
    } catch (e) {
      setError(message(e));
      setBusy(undefined);
    }
  };
  const by = r.by ? whoOf(r.by, names) : undefined;
  const asker = by && by.id !== who.id ? `${by.name} asked for them` : "They asked";
  return (
    <Card as="li" padding="none" className="space-row space-row-asking">
      <Avatar name={who.name} size={32} />
      <div className="space-row-text">
        <p className="space-row-name">
          {who.name}
          <Time at={r.at} />
        </p>
        <p className="space-row-what">
          {error ?? (r.reason ? `${asker}: “${r.reason}”` : `${asker} to join.`)}
        </p>
      </div>
      <div className="space-row-end">
        <Select
          size="sm"
          value={role}
          aria-label={`${who.name}'s role`}
          onChange={(event) => setRole(event.target.value)}
        >
          {ROLES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
        </Select>
        <Button
          size="sm"
          variant="primary"
          loading={busy === "grant"}
          disabled={!!busy}
          onClick={() => void decide("grant")}
        >
          Let in
        </Button>
        <Button
          size="sm"
          variant="ghost"
          loading={busy === "deny"}
          disabled={!!busy}
          onClick={() => void decide("deny")}
        >
          Turn down
        </Button>
      </div>
    </Card>
  );
}
