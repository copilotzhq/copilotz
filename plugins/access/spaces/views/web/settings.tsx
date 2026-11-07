/**
 * A space's settings (kind `space.settings`, its Settings tab): its name,
 * which of its agents answers its new chats (`space.agent`, among those that
 * answer there: its editors), archiving it (which says what it means first,
 * and is undone by Restore), leaving it, and what it is. Those who manage it
 * change them; everyone else reads them. A Personal space keeps its name,
 * and is never archived.
 */
import { type ReactNode, useId, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Button,
  Card,
  CopyButton,
  Dialog,
  Input,
  message,
  Notice,
  Select,
  Skeleton,
  Time,
} from "../../../../../hosts/web/mod.ts";
import type { Member, Reached } from "../../contract.ts";
import type { Roster } from "./agents.tsx";
import { InviteDialog } from "./invite-dialog.tsx";
import { STYLE } from "./style.ts";
import { kindsOf } from "./tabs.ts";
import { byKind, peopleIn, roleName, spaceName, whoOf } from "./who.ts";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export const settingsView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const id = item._id ?? "";
  const spaces = ctx.db.collection("space").query<Reached[]>("reached", {}).value;
  const members = ctx.db.collection<Member>("member").find({ space: id }).value;
  const style = <style href="spaces-web" precedence="copilotz">{STYLE}</style>;
  if (spaces === undefined || members === undefined) {
    return (
      <div className="space-settings" aria-busy="true">
        {style}
        <Skeleton height={120} radius="xl" />
      </div>
    );
  }
  const space = spaces.find((s) => s._id === id);
  if (!space) return null;
  // Agents can be added where the app has them (chat adds the invite surface's Agents).
  const adds = kindsOf(ctx.resources.spaceInvite, space.kind === "personal")
    .some((k) => k.key === "agents");
  // What each of its agents is, as chat says (only when it has agents).
  const roster = byKind(members).agents.length
    ? ctx.db.collection("thread").query<Roster>("agents", { in: id }).value
    : undefined;
  return (
    <>
      {style}
      <Settings
        key={space._id}
        space={space}
        members={members}
        roster={roster}
        adds={adds}
        me={ctx.viewer?.name}
        compact={ctx.hints.mode === "panel"}
        call={ctx.call}
      />
    </>
  );
};

function Settings(
  { space, members, roster, adds, me, compact, call }: {
    space: Reached;
    members: Member[];
    roster?: Roster;
    /** Whether agents can be added here (the app has them). */
    adds: boolean;
    me?: string;
    compact: boolean;
    call: Call;
  },
): ReactNode {
  const personal = space.kind === "personal";
  const manage = space.can.includes("manage");
  const role = members.find((m) => m.member === `person:${me}`)?.role;
  const people = peopleIn(members).length;
  return (
    <div className={`space-settings${compact ? " space-settings-compact" : ""}`}>
      {!manage
        ? (
          <Notice tone="neutral" icon="lock">
            {say("managersChange", { name: spaceName(space) })}
          </Notice>
        )
        : null}
      <Card as="section" padding="none" className="space-setting-list" aria-label={say("settings")}>
        <Setting
          title={say("name")}
          text={personal ? say("nameSettingPersonal") : say("nameSettingShared")}
        >
          {personal
            ? <Input value={say("personal")} disabled aria-label={say("spaceNameLabel")} />
            : <Rename space={space} manage={manage} call={call} />}
        </Setting>
        {adds || byKind(members).agents.length
          ? (
            <Answers
              space={space}
              members={members}
              roster={roster}
              manage={manage}
              adds={adds}
              call={call}
            />
          )
          : null}
        {!personal && manage ? <Archive space={space} call={call} /> : null}
        {!personal && role ? <Leave space={space} call={call} /> : null}
      </Card>
      <Card as="section" className="space-setting-about" aria-labelledby="space-setting-about">
        <h3 id="space-setting-about" className="space-section-title">{say("aboutLabel")}</h3>
        <dl className="space-facts">
          <dt>{say("kind")}</dt>
          <dd>{personal ? say("kindPersonal") : say("shared")}</dd>
          {role
            ? (
              <>
                <dt>{say("yourRole")}</dt>
                <dd>{roleName(role)}</dd>
              </>
            )
            : null}
          <dt>{say("people")}</dt>
          <dd>{people}</dd>
          <dt>{say("id")}</dt>
          <dd className="space-facts-id">
            <code>{space._id}</code>
            <CopyButton text={space._id} label={say("copySpaceId")} />
          </dd>
        </dl>
      </Card>
    </div>
  );
}

/**
 * Leaving it, after a second press (nothing to undo but asking to be let
 * back in): to your Personal space after. Its only manager is told to make
 * someone else one first.
 */
function Leave({ space, call }: { space: Reached; call: Call }): ReactNode {
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Setting
      title={say("leave")}
      text={error ?? say("leaveAbout")}
    >
      {sure
        ? (
          <div className="space-setting-form">
            <Button onClick={() => setSure(false)} disabled={busy}>{say("stay")}</Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await call("space.leave", { space: space._id });
                  location.href = "/";
                } catch (e) {
                  setError(message(e));
                  setSure(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {say("leaveNamed", { name: spaceName(space) })}
            </Button>
          </div>
        )
        : <Button onClick={() => setSure(true)}>{say("leaveThisSpace")}</Button>}
    </Setting>
  );
}

/**
 * Archiving it, once they've read what it means (it stays readable, as it
 * was, and is listed apart), or restoring it, at once.
 */
function Archive({ space, call }: { space: Reached; call: Call }): ReactNode {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const archive = async (archived: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      await call("space.archive", { space: space._id, archived });
      setAsking(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Setting
      title={space.archived ? say("archived") : say("archiveSetting")}
      text={error ??
        (space.archived
          ? say.nodes("archivedAt", { time: <Time at={space.archived} long /> })
          : say("archiveAbout"))}
    >
      {space.archived
        ? (
          <Button icon="restore" loading={busy} onClick={() => void archive(false)}>
            {say("restore")}
          </Button>
        )
        : <Button icon="archive" onClick={() => setAsking(true)}>{say("archiveMenu")}</Button>}
      <Dialog
        open={asking}
        onClose={() => setAsking(false)}
        size="sm"
        title={say("archiveTitle", { name: space.name })}
        footer={
          <>
            <Button onClick={() => setAsking(false)}>{say("cancel")}</Button>
            <Button
              variant="primary"
              icon="archive"
              loading={busy}
              onClick={() => void archive(true)}
            >
              {say("archiveSetting")}
            </Button>
          </>
        }
      >
        <ul className="space-archive-means">
          <li>
            <b>{say("archiveReadableLead")}</b> {say("archiveReadableRest")}
          </li>
          <li>
            <b>{say("archiveApartLead")}</b> {say("archiveApartRest")}
          </li>
          <li>
            <b>{say("archiveBackLead")}</b> {say("archiveBackRest")}
          </li>
        </ul>
        {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      </Dialog>
    </Setting>
  );
}

/** A setting: what it is and what it does, beside where it's changed. */
function Setting(
  { title, text, children }: { title: string; text: ReactNode; children: ReactNode },
): ReactNode {
  const id = useId();
  return (
    <div className="space-setting" role="group" aria-labelledby={id}>
      <div className="space-setting-about-it">
        <h3 id={id}>{title}</h3>
        <p className="space-setting-text">{text}</p>
      </div>
      <div className="space-setting-control">{children}</div>
    </div>
  );
}

function Rename(
  { space, manage, call }: { space: Reached; manage: boolean; call: Call },
): ReactNode {
  const [name, setName] = useState(space.name);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ error?: string; saved?: boolean }>({});
  const changed = !!name.trim() && name.trim() !== space.name;
  return (
    <form
      className="space-setting-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!changed || busy) return;
        setBusy(true);
        try {
          await call("space.rename", { space: space._id, name: name.trim() });
          setSaid({ saved: true });
        } catch (e) {
          setSaid({ error: message(e) });
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="space-setting-inline">
        <Input
          value={name}
          maxLength={60}
          disabled={!manage}
          autoComplete="off"
          aria-label={say("spaceNameLabel")}
          invalid={!!said.error}
          onChange={(event) => {
            setName(event.target.value);
            setSaid({});
          }}
        />
        {manage
          ? (
            <Button type="submit" variant="primary" loading={busy} disabled={!changed}>
              {say("save")}
            </Button>
          )
          : null}
      </div>
      {said.error
        ? <p role="alert" className="space-setting-note space-invite-error">{said.error}</p>
        : said.saved
        ? <p role="status" className="space-setting-note space-invite-done">{say("saved")}</p>
        : null}
    </form>
  );
}

/**
 * Which agent answers chats started here (`space.agent`): one of the agents
 * that answer here (its editors), by name; chosen by those who manage it.
 * Without any, they add one here (the invite surface, at Agents).
 */
function Answers(
  { space, members, roster, manage, adds, call }: {
    space: Reached;
    members: Member[];
    roster?: Roster;
    manage: boolean;
    adds: boolean;
    call: Call;
  },
): ReactNode {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const agents = byKind(members).agents;
  const answering = agents.filter((m) => m.role === "editor").map((m) => whoOf(m.member).id);
  const current = roster?.default[0] ?? space.agent;
  const name = (id: string) => roster?.agents[id]?.name || id;
  const label = (id: string) =>
    `${roster?.agents[id]?.icon ? `${roster.agents[id].icon}  ` : ""}${name(id)}`;
  const choices = current && !answering.includes(current) ? [current, ...answering] : answering;
  return (
    <Setting
      title={say("answersNew")}
      text={error ??
        (answering.length
          ? say("answersAbout")
          : agents.length
          ? say("answersViewersOnly")
          : say("answersNone"))}
    >
      {choices.length
        ? (
          <div className="space-setting-form">
            <Select
              value={current ?? ""}
              disabled={!manage || busy}
              aria-label={say("answersLabel")}
              onChange={async (event) => {
                setBusy(true);
                setError(undefined);
                setSaved(false);
                try {
                  await call("space.agent", { space: space._id, agent: event.target.value });
                  setSaved(true);
                } catch (e) {
                  setError(message(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {choices.map((id) => <option key={id} value={id}>{label(id)}</option>)}
            </Select>
            {saved
              ? (
                <p role="status" className="space-setting-note space-invite-done">
                  {say("answersNow", { name: name(current ?? "") })}
                </p>
              )
              : null}
          </div>
        )
        : manage && adds && !space.archived
        ? (
          <>
            <Button icon="plus" onClick={() => setAdding(true)}>{say("addAgent")}</Button>
            <InviteDialog
              open={adding}
              onClose={() => setAdding(false)}
              space={space}
              tab="agents"
            />
          </>
        )
        : null}
    </Setting>
  );
}
