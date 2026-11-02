/**
 * The platform console (kind `console`, at `/console`), for staff where the
 * app serves many orgs: every org, with what it last reported (its people,
 * spaces, when it was last active), where its rows live and whether it's
 * suspended; searched by name, id, schema or maker, and filtered by kind or
 * status. For each: entering it as staff (on its record, as theirs), and
 * from its menu renaming it, suspending it (nobody but staff goes in) or
 * lifting that, moving its rows to a schema of its own, downloading them as
 * SQL, and deleting it for good, which its exact name confirms. The console
 * reads no org's content: only what the directory keeps. Its other tab (`?tab=codes`,
 * console-codes.tsx): gift codes of credits, made, listed and taken back.
 */
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import type { ViewContext } from "../../../../runtime/mod.ts";
import {
  Avatar,
  Badge,
  Button,
  type ConsoleOrg,
  consoleOrgs,
  CopyButton,
  deleteOrg,
  Dialog,
  EmptyState,
  enterOrg,
  exportOrgUrl,
  Field,
  go,
  Icon,
  Input,
  Menu,
  message,
  moveOrg,
  Notice,
  Page,
  Skeleton,
  Tabs,
  Time,
  Title,
  updateOrg,
  useOrgs,
} from "../../../../hosts/web/mod.ts";
import { type ConsoleFilter, consoleList, consoleTotals, SCHEMA } from "../shared/orgs.ts";
import { GiftCodes } from "./console-codes.tsx";

export const consoleView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => (
  <Console tab={(ctx.hints.query as Record<string, string> | undefined)?.tab} />
);

/** What staff are doing to an org, in a dialog. */
type Doing = { what: "rename" | "suspend" | "move" | "delete"; org: ConsoleOrg };

const FILTERS: { value: ConsoleFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "team", label: "Teams" },
  { value: "personal", label: "Personal" },
  { value: "suspended", label: "Suspended" },
];

/** The console's tabs: the address says which (`?tab=codes`). */
const CONSOLE_TABS = [
  { value: "orgs", label: "Organizations", icon: "building", href: "/console" },
  { value: "codes", label: "Gift codes", icon: "star", href: "/console?tab=codes" },
] as const;

function Console({ tab }: { tab?: string }): ReactNode {
  const orgs = useOrgs();
  const staff = orgs.status === "ready" && orgs.value.staff;
  const [list, setList] = useState<ConsoleOrg[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ConsoleFilter>("all");
  const [doing, setDoing] = useState<Doing>();
  const [done, setDone] = useState<string>();
  const load = async () => {
    setLoading(true);
    try {
      setList(await consoleOrgs());
      setError(undefined);
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (staff) void load();
  }, [staff]);
  useEffect(() => {
    if (!done) return;
    const gone = setTimeout(() => setDone(undefined), 4000);
    return () => clearTimeout(gone);
  }, [done]);
  const shown = useMemo(() => consoleList(list ?? [], search, filter), [list, search, filter]);
  const totals = useMemo(() => consoleTotals(list ?? []), [list]);

  if (orgs.status !== "loading" && !staff) {
    return (
      <div className="copilotz-org-missing">
        <Title text="Console" />
        <EmptyState
          icon="lock"
          heading="h1"
          title="For platform staff"
          action={<Button variant="primary" href="/">Go home</Button>}
        >
          The console lists every organization, for the people who run this app.
        </EmptyState>
      </div>
    );
  }
  const current = orgs.status === "ready" ? orgs.value.current : null;
  /** A dialog's closing ends what it was for, and nothing that started since. */
  const closer = (what: Doing["what"]) => () =>
    setDoing((now) => now?.what === what ? undefined : now);
  const finished = (note: string) => {
    setDoing(undefined);
    setDone(note);
    void load();
  };
  const tabs = (
    <Tabs
      label="What the console shows"
      variant="line"
      className="console-tabs"
      value={tab === "codes" ? "codes" : "orgs"}
      onChange={(next) => go(next === "codes" ? "/console?tab=codes" : "/console")}
      tabs={[...CONSOLE_TABS]}
    />
  );
  if (tab === "codes") {
    return (
      <Page
        title="Gift codes"
        icon="server"
        width="full"
        className="console"
        badges={<Badge tone="warning">Staff</Badge>}
        description="Credits waiting to be claimed. Someone who runs an org types one in under Billing, and its credits are that org's."
      >
        <Title text="Gift codes" />
        {tabs}
        <GiftCodes orgs={list ?? []} ready={staff} />
      </Page>
    );
  }
  return (
    <Page
      title="Organizations"
      icon="server"
      width="full"
      className="console"
      badges={<Badge tone="warning">Staff</Badge>}
      description="Every org on this app: what each last reported, where its rows live, and what you can do about it. Nothing here reads an org's content."
      actions={
        <Button size="sm" icon="refresh" loading={loading} onClick={() => void load()}>
          Refresh
        </Button>
      }
    >
      <Title text="Console" />
      {tabs}
      <div className="console-stats" aria-busy={!list || undefined}>
        <Stat label="Organizations" value={list ? totals.orgs : undefined} />
        <Stat label="Team orgs" value={list ? totals.teams : undefined} />
        <Stat label="People" value={list ? totals.people : undefined} />
        <Stat
          label="Suspended"
          value={list ? totals.suspended : undefined}
          tone={totals.suspended ? "warning" : undefined}
        />
      </div>
      <div className="console-tools">
        <Input
          icon="search"
          type="search"
          size="sm"
          className="console-search"
          placeholder="Search by name, id, schema or maker"
          aria-label="Search organizations"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Tabs
          label="Which organizations"
          value={filter}
          onChange={setFilter}
          tabs={FILTERS.map((f) => ({
            ...f,
            ...(list && f.value === "suspended" && totals.suspended
              ? { count: totals.suspended }
              : {}),
          }))}
        />
      </div>
      {error
        ? (
          <Notice tone="destructive" role="alert" className="console-notice">
            {error}
          </Notice>
        )
        : null}
      {done
        ? (
          <Notice tone="success" className="console-notice" role="status">
            {done}
          </Notice>
        )
        : null}
      {!list
        ? (
          <div className="console-loading" aria-busy="true">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={52} radius="md" />)}
          </div>
        )
        : shown.length
        ? (
          <div className="console-table" role="table" aria-label="Organizations">
            <div className="console-row console-head" role="row">
              <span role="columnheader">Organization</span>
              <span role="columnheader" className="console-num">People</span>
              <span role="columnheader" className="console-num">Spaces</span>
              <span role="columnheader">Last active</span>
              <span role="columnheader">Placement</span>
              <span role="columnheader">Status</span>
              <span role="columnheader" className="console-sr">Actions</span>
            </div>
            {shown.map((org) => (
              <Row
                key={org.id}
                org={org}
                here={org.id === current}
                onDo={(what) => setDoing({ what, org })}
              />
            ))}
          </div>
        )
        : (
          <EmptyState icon="search" title="No organization matches">
            {search ? `Nothing matches “${search.trim()}”` : "Nothing in this list yet."}
          </EmptyState>
        )}
      {list && shown.length
        ? (
          <p className="console-foot">
            {shown.length === list.length
              ? `${list.length} ${list.length === 1 ? "organization" : "organizations"}`
              : `${shown.length} of ${list.length} organizations`}
            {" · "}the most recently active first
          </p>
        )
        : null}
      <RenameDialog doing={doing} close={closer("rename")} finished={finished} />
      <SuspendDialog doing={doing} close={closer("suspend")} finished={finished} />
      <MoveDialog doing={doing} close={closer("move")} finished={finished} />
      <DeleteDialog doing={doing} close={closer("delete")} finished={finished} />
    </Page>
  );
}

function Stat(
  { label, value, tone }: { label: string; value?: number; tone?: "warning" },
): ReactNode {
  return (
    <div className="console-stat" data-tone={tone}>
      <span className="console-stat-label">{label}</span>
      {value === undefined
        ? <Skeleton height={26} width={48} />
        : <span className="console-stat-value">{value.toLocaleString()}</span>}
    </div>
  );
}

function Row(
  { org, here, onDo }: { org: ConsoleOrg; here: boolean; onDo(what: Doing["what"]): void },
): ReactNode {
  const [entering, setEntering] = useState(false);
  const [error, setError] = useState<string>();
  const people = org.summary?.people ?? org.members;
  const enter = () => {
    setEntering(true);
    setError(undefined);
    enterOrg(org, true).catch((e) => {
      setError(message(e));
      setEntering(false);
    });
  };
  return (
    <div className="console-row" role="row" data-suspended={org.suspended || undefined}>
      <span role="cell" className="console-org">
        {org.kind === "personal"
          ? <Avatar name={org.by} size={30} />
          : <Avatar name={org.name} kind="org" size={30} tint={org.id} />}
        <span className="console-org-text">
          <span className="console-org-name">
            {org.name}
            {here ? <Badge tone="primary">You're here</Badge> : null}
          </span>
          <span className="console-org-meta">
            <span className="console-kind">{org.kind === "personal" ? "Personal" : "Team"}</span>
            <span aria-hidden="true">·</span>
            <code title={org.id}>{org.id}</code>
            <CopyButton text={org.id} label="Copy the org's id" />
          </span>
          {error ? <span className="console-error">{error}</span> : null}
        </span>
      </span>
      <span role="cell" className="console-num" data-label="People">
        {people.toLocaleString()}
      </span>
      <span role="cell" className="console-num" data-label="Spaces">
        {org.summary?.spaces === undefined ? "—" : org.summary.spaces.toLocaleString()}
      </span>
      <span role="cell" className="console-active" data-label="Last active">
        {org.summary?.active ? <Time at={org.summary.active} /> : <span>Not yet</span>}
      </span>
      <span role="cell" className="console-placement" data-label="Placement">
        <Icon name="server" size={13} />
        <code>{org.placement?.schema ?? "—"}</code>
      </span>
      <span role="cell" data-label="Status">
        {org.suspended
          ? <Badge tone="warning" variant="soft">Suspended</Badge>
          : <Badge tone="success" variant="soft">Active</Badge>}
      </span>
      <span role="cell" className="console-actions">
        <Button
          size="sm"
          icon="enter"
          loading={entering}
          disabled={here}
          onClick={enter}
          title={here
            ? "You're in it"
            : `Go into ${org.name} as staff: what you do there is on its record`}
        >
          Enter as staff
        </Button>
        <Menu
          label={`${org.name}: more`}
          align="end"
          size="sm"
          items={[
            { label: "Rename…", icon: "pencil", onSelect: () => onDo("rename") },
            org.suspended
              ? { label: "Lift the suspension…", icon: "play", onSelect: () => onDo("suspend") }
              : { label: "Suspend…", icon: "pause", onSelect: () => onDo("suspend") },
            { label: "Move to another schema…", icon: "move", onSelect: () => onDo("move") },
            { label: "Export its rows (SQL)", icon: "download", href: exportOrgUrl(org.id) },
            "separator",
            {
              label: "Delete for good…",
              icon: "trash",
              tone: "destructive",
              onSelect: () => onDo("delete"),
            },
          ]}
        />
      </span>
    </div>
  );
}

type DialogProps = { doing?: Doing; close(): void; finished(note: string): void };

/** Doing something to an org in a dialog: busy while it goes, and why it failed if it does. */
function useAct(doing?: Doing) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setBusy(false);
    setError(undefined);
  }, [doing]);
  const act = async (run: () => Promise<unknown>, then: () => void) => {
    setBusy(true);
    setError(undefined);
    try {
      await run();
      then();
    } catch (e) {
      const code = (e as { code?: string }).code;
      setError(
        code === "unsupported" ? `This app doesn't do that yet. (${message(e)})` : message(e),
      );
      setBusy(false);
    }
  };
  return { busy, error, act };
}

function RenameDialog({ doing, close, finished }: DialogProps): ReactNode {
  const open = doing?.what === "rename";
  const org = doing?.org;
  const [name, setName] = useState("");
  const { busy, error, act } = useAct(doing);
  useEffect(() => setName(org?.name ?? ""), [doing]);
  const typed = name.trim();
  const save = (event?: FormEvent) => {
    event?.preventDefault();
    if (!org || !typed || typed === org.name) return;
    void act(() => updateOrg(org.id, { name: typed }), () => finished(`Renamed to “${typed}”.`));
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      size="sm"
      title="Rename organization"
      description={org ? `Its people see the new name at once, everywhere.` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!typed || typed === org?.name}
            onClick={() => save()}
          >
            Rename
          </Button>
        </>
      }
    >
      <form onSubmit={save}>
        <Field label="Name" error={error}>
          {(control) => (
            <Input
              {...control}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              autoFocus
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

function SuspendDialog({ doing, close, finished }: DialogProps): ReactNode {
  const open = doing?.what === "suspend";
  const org = doing?.org;
  const lifting = !!org?.suspended;
  const { busy, error, act } = useAct(doing);
  return (
    <Dialog
      open={open}
      onClose={close}
      size="sm"
      title={org ? `${lifting ? "Lift the suspension of" : "Suspend"} ${org.name}?` : ""}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
          <Button
            variant={lifting ? "primary" : "destructive"}
            loading={busy}
            onClick={() =>
              org &&
              void act(
                () => updateOrg(org.id, { suspended: !lifting }),
                () =>
                  finished(lifting ? `${org.name} is open again.` : `${org.name} is suspended.`),
              )}
          >
            {lifting ? "Lift the suspension" : "Suspend"}
          </Button>
        </>
      }
    >
      <p className="console-dialog-text">
        {lifting
          ? "Its people can go in again, as before. Nothing in it changed while it was suspended."
          : "Nobody but staff goes in until you lift it: its people see that it's suspended. Nothing in it is changed or deleted."}
      </p>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
    </Dialog>
  );
}

function MoveDialog({ doing, close, finished }: DialogProps): ReactNode {
  const open = doing?.what === "move";
  const org = doing?.org;
  const [schema, setSchema] = useState("");
  const { busy, error, act } = useAct(doing);
  useEffect(() => setSchema(org ? `org_${org.id.replace(/[^a-z0-9]/gi, "_").toLowerCase()}` : ""), [
    doing,
  ]);
  const typed = schema.trim();
  const bad = typed !== "" && !SCHEMA.test(typed);
  const same = typed === org?.placement?.schema;
  const move = (event?: FormEvent) => {
    event?.preventDefault();
    if (!org || !typed || bad || same) return;
    void act(() => moveOrg(org.id, typed), () => finished(`${org.name} now lives in “${typed}”.`));
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={org ? `Move ${org.name}` : ""}
      description="For big orgs: gives it a schema of its own, so its load and its rows stand apart from the shared pool."
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!typed || bad || same}
            onClick={() => move()}
          >
            Move its rows
          </Button>
        </>
      }
    >
      <form onSubmit={move} className="console-move">
        <p className="console-dialog-text">
          It's closed for a moment, its rows are copied to the new schema as they are, and it opens
          there on its next use. Its people may see it reconnect.
        </p>
        <div className="console-move-from">
          <span>Now in</span>
          <code>{org?.placement?.schema ?? "—"}</code>
        </div>
        <Field
          label="New schema"
          hint={same
            ? "That's where it is now."
            : "Lowercase letters, digits and _, starting with a letter."}
          error={bad ? "Lowercase letters, digits and _, starting with a letter." : error}
        >
          {(control) => (
            <Input
              {...control}
              value={schema}
              onChange={(e) => setSchema(e.target.value)}
              spellCheck={false}
              autoCapitalize="none"
              className="console-mono"
              autoFocus
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ doing, close, finished }: DialogProps): ReactNode {
  const open = doing?.what === "delete";
  const org = doing?.org;
  const [typed, setTyped] = useState("");
  const { busy, error, act } = useAct(doing);
  useEffect(() => setTyped(""), [doing]);
  const matches = !!org && typed === org.name;
  const remove = (event?: FormEvent) => {
    event?.preventDefault();
    if (!org || !matches) return;
    void act(() => deleteOrg(org.id, typed), () => finished(`${org.name} is deleted.`));
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={org ? `Delete ${org.name} for good?` : ""}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
          <Button
            variant="destructive"
            icon="trash"
            loading={busy}
            disabled={!matches}
            onClick={() => remove()}
          >
            Delete for good
          </Button>
        </>
      }
    >
      <form onSubmit={remove} className="console-delete">
        <Notice tone="destructive" icon="alert" title="This can't be undone">
          Everything in it goes: its people's memberships, spaces, conversations, agents, files and
          usage. Its people are signed out of it at once. Export its rows first if you may need
          them.
        </Notice>
        {org
          ? (
            <a className="console-export" href={exportOrgUrl(org.id)} download>
              <Icon name="download" size={15} />
              Export its rows (SQL) first
            </a>
          )
          : null}
        <Field
          label={
            <>
              Type <b className="console-name">{org?.name}</b> to confirm
            </>
          }
          error={error}
        >
          {(control) => (
            <Input
              {...control}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
