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
  CopyButton,
  Dialog,
  EmptyState,
  Field,
  formatNumber,
  go,
  Icon,
  Input,
  Menu,
  message,
  Notice,
  Page,
  Skeleton,
  Tabs,
  Time,
  Title,
} from "../../../../hosts/web/mod.ts";
import {
  type ConsoleOrg,
  consoleOrgs,
  deleteOrg,
  enterOrg,
  exportOrgUrl,
  moveOrg,
  updateOrg,
  useOrgs,
} from "../../../access/directory/contract.ts";
import { type ConsoleFilter, consoleList, consoleTotals, SCHEMA } from "../shared/orgs.ts";
import { GiftCodes } from "./console-codes.tsx";
import { say } from "./words.ts";

export const consoleView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => (
  <Console tab={(ctx.hints.query as Record<string, string> | undefined)?.tab} />
);

/** What staff are doing to an org, in a dialog. */
export type Doing = { what: "rename" | "suspend" | "move" | "delete"; org: ConsoleOrg };

const filters = (): { value: ConsoleFilter; label: string }[] => [
  { value: "all", label: say("filterAll") },
  { value: "team", label: say("filterTeams") },
  { value: "personal", label: say("personal") },
  { value: "suspended", label: say("suspended") },
];

/** The console's tabs: the address says which (`?tab=codes`). */
const consoleTabs = () =>
  [
    { value: "orgs", label: say("organizations"), icon: "building", href: "/console" },
    { value: "codes", label: say("giftCodes"), icon: "star", href: "/console?tab=codes" },
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
        <Title text={say("consoleTitle")} />
        <EmptyState
          icon="lock"
          heading="h1"
          title={say("forStaff")}
          action={<Button variant="primary" href="/">{say("goHome")}</Button>}
        >
          {say("forStaffAbout")}
        </EmptyState>
      </div>
    );
  }
  const current = orgs.status === "ready" ? orgs.value.current : null;
  const inAsStaff = orgs.status === "ready" && orgs.value.asStaff;
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
      label={say("consoleShows")}
      variant="line"
      className="console-tabs"
      value={tab === "codes" ? "codes" : "orgs"}
      onChange={(next) => go(next === "codes" ? "/console?tab=codes" : "/console")}
      tabs={[...consoleTabs()]}
    />
  );
  if (tab === "codes") {
    return (
      <Page
        title={say("giftCodes")}
        icon="server"
        width="full"
        className="console"
        badges={<Badge tone="warning">{say("staff")}</Badge>}
        description={say("giftCodesAbout")}
      >
        <Title text={say("giftCodes")} />
        {tabs}
        <GiftCodes orgs={list ?? []} ready={staff} />
      </Page>
    );
  }
  return (
    <Page
      title={say("organizations")}
      icon="server"
      width="full"
      className="console"
      badges={<Badge tone="warning">{say("staff")}</Badge>}
      description={say("consoleAbout")}
      actions={
        <Button size="sm" icon="refresh" loading={loading} onClick={() => void load()}>
          {say("refresh")}
        </Button>
      }
    >
      <Title text={say("consoleTitle")} />
      {tabs}
      <div className="console-stats" aria-busy={!list || undefined}>
        <Stat label={say("organizations")} value={list ? totals.orgs : undefined} />
        <Stat label={say("teamOrgs")} value={list ? totals.teams : undefined} />
        <Stat label={say("people")} value={list ? totals.people : undefined} />
        <Stat
          label={say("suspended")}
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
          placeholder={say("searchPlaceholder")}
          aria-label={say("searchOrgs")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Tabs
          label={say("whichOrgs")}
          value={filter}
          onChange={setFilter}
          tabs={filters().map((f) => ({
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
          <div className="console-table" role="table" aria-label={say("organizations")}>
            <div className="console-row console-head" role="row">
              <span role="columnheader">{say("organization")}</span>
              <span role="columnheader" className="console-num">{say("people")}</span>
              <span role="columnheader" className="console-num">{say("spaces")}</span>
              <span role="columnheader">{say("lastActive")}</span>
              <span role="columnheader">{say("placement")}</span>
              <span role="columnheader">{say("status")}</span>
              <span role="columnheader" className="console-sr">{say("actions")}</span>
            </div>
            {shown.map((org) => (
              <Row
                key={org.id}
                org={org}
                here={org.id === current}
                inAsStaff={org.id === current && inAsStaff}
                onDo={(what) => setDoing({ what, org })}
              />
            ))}
          </div>
        )
        : (
          <EmptyState icon="search" title={say("noMatch")}>
            {search ? say("nothingMatches", { search: search.trim() }) : say("nothingYet")}
          </EmptyState>
        )}
      {list && shown.length
        ? (
          <p className="console-foot">
            {shown.length === list.length
              ? say("footAll", { count: list.length })
              : say("footSome", { shown: shown.length, total: list.length })}
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
        : <span className="console-stat-value">{formatNumber(value)}</span>}
    </div>
  );
}

/** One org in the console's table. */
export function Row(
  { org, here, inAsStaff, onDo }: {
    org: ConsoleOrg;
    here: boolean;
    inAsStaff: boolean;
    onDo(what: Doing["what"]): void;
  },
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
            {here
              ? <Badge tone="primary">{inAsStaff ? say("hereAsStaff") : say("youreHere")}</Badge>
              : null}
          </span>
          <span className="console-org-meta">
            <span className="console-kind">
              {org.kind === "personal" ? say("personal") : say("team")}
            </span>
            <span aria-hidden="true">·</span>
            <code title={org.id}>{org.id}</code>
            <CopyButton text={org.id} label={say("copyOrgId")} />
          </span>
          {error ? <span className="console-error">{error}</span> : null}
        </span>
      </span>
      <span role="cell" className="console-num" data-label={say("people")}>
        {formatNumber(people)}
      </span>
      <span role="cell" className="console-num" data-label={say("spaces")}>
        {org.summary?.spaces === undefined ? "—" : formatNumber(org.summary.spaces)}
      </span>
      <span role="cell" className="console-active" data-label={say("lastActive")}>
        {org.summary?.active ? <Time at={org.summary.active} /> : <span>{say("notYet")}</span>}
      </span>
      <span role="cell" className="console-placement" data-label={say("placement")}>
        <Icon name="server" size={13} />
        <code>{org.placement?.schema ?? "—"}</code>
      </span>
      <span role="cell" data-label={say("status")}>
        {org.suspended
          ? <Badge tone="warning" variant="soft">{say("suspended")}</Badge>
          : <Badge tone="success" variant="soft">{say("active")}</Badge>}
      </span>
      <span role="cell" className="console-actions">
        <Button
          size="sm"
          icon="enter"
          loading={entering}
          disabled={inAsStaff}
          onClick={enter}
          title={inAsStaff ? say("inItAsStaff") : say("goIntoAsStaff", { name: org.name })}
        >
          {say("enterAsStaff")}
        </Button>
        <Menu
          label={say("moreOf", { name: org.name })}
          align="end"
          size="sm"
          items={[
            { label: say("renameMore"), icon: "pencil", onSelect: () => onDo("rename") },
            org.suspended
              ? { label: say("liftMore"), icon: "play", onSelect: () => onDo("suspend") }
              : { label: say("suspendMore"), icon: "pause", onSelect: () => onDo("suspend") },
            { label: say("moveMore"), icon: "move", onSelect: () => onDo("move") },
            { label: say("exportRows"), icon: "download", href: exportOrgUrl(org.id) },
            "separator",
            {
              label: say("deleteMore"),
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

export type DialogProps = { doing?: Doing; close(): void; finished(note: string): void };

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
        code === "unsupported" ? say("unsupported", { reason: message(e) }) : message(e),
      );
      setBusy(false);
    }
  };
  return { busy, error, act };
}

export function RenameDialog({ doing, close, finished }: DialogProps): ReactNode {
  const open = doing?.what === "rename";
  const org = doing?.org;
  const [name, setName] = useState("");
  const { busy, error, act } = useAct(doing);
  useEffect(() => setName(org?.name ?? ""), [doing]);
  const typed = name.trim();
  const save = (event?: FormEvent) => {
    event?.preventDefault();
    if (!org || !typed || typed === org.name) return;
    void act(
      () => updateOrg(org.id, { name: typed }),
      () => finished(say("renamedTo", { name: typed })),
    );
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      size="sm"
      title={say("renameOrg")}
      description={org ? say("renameOrgAbout") : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>{say("cancel")}</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!typed || typed === org?.name}
            onClick={() => save()}
          >
            {say("rename")}
          </Button>
        </>
      }
    >
      <form onSubmit={save}>
        <Field label={say("name")} error={error}>
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

export function SuspendDialog({ doing, close, finished }: DialogProps): ReactNode {
  const open = doing?.what === "suspend";
  const org = doing?.org;
  const lifting = !!org?.suspended;
  const { busy, error, act } = useAct(doing);
  return (
    <Dialog
      open={open}
      onClose={close}
      size="sm"
      title={org ? say(lifting ? "liftTitle" : "suspendTitle", { name: org.name }) : ""}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>{say("cancel")}</Button>
          <Button
            variant={lifting ? "primary" : "destructive"}
            loading={busy}
            onClick={() =>
              org &&
              void act(
                () => updateOrg(org.id, { suspended: !lifting }),
                () =>
                  finished(
                    say(lifting ? "openAgain" : "isSuspended", { name: org.name }),
                  ),
              )}
          >
            {lifting ? say("lift") : say("suspend")}
          </Button>
        </>
      }
    >
      <p className="console-dialog-text">
        {lifting ? say("liftAbout") : say("suspendAbout")}
      </p>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
    </Dialog>
  );
}

export function MoveDialog({ doing, close, finished }: DialogProps): ReactNode {
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
    void act(
      () => moveOrg(org.id, typed),
      () => finished(say("nowLivesIn", { name: org.name, schema: typed })),
    );
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={org ? say("moveTitle", { name: org.name }) : ""}
      description={say("moveAbout")}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>{say("cancel")}</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!typed || bad || same}
            onClick={() => move()}
          >
            {say("moveRows")}
          </Button>
        </>
      }
    >
      <form onSubmit={move} className="console-move">
        <p className="console-dialog-text">
          {say("moveText")}
        </p>
        <div className="console-move-from">
          <span>{say("nowIn")}</span>
          <code>{org?.placement?.schema ?? "—"}</code>
        </div>
        <Field
          label={say("newSchema")}
          hint={same ? say("sameSchema") : say("schemaRule")}
          error={bad ? say("schemaRule") : error}
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

export function DeleteDialog({ doing, close, finished }: DialogProps): ReactNode {
  const open = doing?.what === "delete";
  const org = doing?.org;
  const [typed, setTyped] = useState("");
  const { busy, error, act } = useAct(doing);
  useEffect(() => setTyped(""), [doing]);
  const matches = !!org && typed === org.name;
  const remove = (event?: FormEvent) => {
    event?.preventDefault();
    if (!org || !matches) return;
    void act(() => deleteOrg(org.id, typed), () => finished(say("isDeleted", { name: org.name })));
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={org ? say("deleteTitle", { name: org.name }) : ""}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>{say("cancel")}</Button>
          <Button
            variant="destructive"
            icon="trash"
            loading={busy}
            disabled={!matches}
            onClick={() => remove()}
          >
            {say("deleteForGood")}
          </Button>
        </>
      }
    >
      <form onSubmit={remove} className="console-delete">
        <Notice tone="destructive" icon="alert" title={say("cantUndo")}>
          {say("deleteAbout")}
        </Notice>
        {org
          ? (
            <a className="console-export" href={exportOrgUrl(org.id)} download>
              <Icon name="download" size={15} />
              {say("exportFirst")}
            </a>
          )
          : null}
        <Field
          label={say.nodes("typeToConfirm", { name: <b className="console-name">{org?.name}</b> })}
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
