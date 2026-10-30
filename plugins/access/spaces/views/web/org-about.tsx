/**
 * What the org is (kind `org.about`, a section of the org's page, the web
 * shell's `orgSettings`), where the app serves many orgs: its name, which
 * its owners change (`org.rename`; the switcher follows), your role there and
 * what it lets you do, and, said calmly once, what its owners and admins
 * can see: everything in it, Personal spaces included, so they can help and
 * hand work over when someone leaves. Staff are told what being here as
 * staff means.
 */
import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  Icon,
  Input,
  message,
  Notice,
  refreshOrgs,
} from "../../../../../hosts/web/mod.ts";
import {
  ORG_ROLES,
  orgRoleName,
  runs,
  type Standing,
} from "../../../../interfaces/web/contract.ts";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;
type Org = { id: string; name: string; kind: string };

export const orgAboutView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const org = ctx.hints.org as Org | undefined;
  if (!org) return null;
  const standing = {
    role: (ctx.hints.role as string | null | undefined) ?? null,
    staff: ctx.hints.staff === true,
  };
  return (
    <>
      <style href="spaces-web" precedence="copilotz">{STYLE}</style>
      <About org={org} standing={standing} call={ctx.call} />
    </>
  );
};

function About({ org, standing, call }: { org: Org; standing: Standing; call: Call }): ReactNode {
  const personal = org.kind === "personal";
  const owner = standing.staff || standing.role === "owner";
  const role = ORG_ROLES.find((r) => r.value === standing.role);
  return (
    <div className="space-settings org-about">
      <Card as="section" padding="none" className="space-setting-list" aria-label="About">
        <Setting
          title="Name"
          text={personal
            ? "Your personal org shows as Personal, to you."
            : owner
            ? "What everyone in it sees it as: in the switcher, and when they're invited."
            : "Its owners change its name."}
        >
          {personal
            ? <Input value="Personal" disabled aria-label="The org's name" />
            : <Rename org={org} owner={owner} call={call} />}
        </Setting>
        <Setting
          title="Your role"
          text={standing.role
            ? role?.lets ?? ""
            : "Platform staff: you reach all of it, and what you do here is on its record, as yours."}
        >
          <span className="org-about-role">
            {standing.role
              ? (
                <Badge tone={runs(standing) ? "primary" : "neutral"}>
                  {orgRoleName(standing.role)}
                </Badge>
              )
              : (
                <Badge tone="warning">
                  <Icon name="shield" size={12} />
                  Staff
                </Badge>
              )}
          </span>
        </Setting>
      </Card>
      {personal ? null : <WhoSees org={org} standing={standing} />}
      <Card as="section" className="space-setting-about" aria-labelledby="org-facts">
        <h3 id="org-facts" className="space-section-title">Details</h3>
        <dl className="space-facts">
          <dt>Kind</dt>
          <dd>{personal ? "Personal: yours alone" : "Team"}</dd>
          <dt>Roles</dt>
          <dd className="org-about-roles">
            {ORG_ROLES.map((r) => (
              <span key={r.value}>
                <b>{r.label}</b> {r.lets.charAt(0).toLowerCase() + r.lets.slice(1)}.
              </span>
            ))}
          </dd>
          <dt>Id</dt>
          <dd className="space-facts-id">
            <code>{org.id}</code>
            <CopyButton text={org.id} label="Copy the org's id" />
          </dd>
        </dl>
      </Card>
    </div>
  );
}

/** What its owners and admins reach, said once, calmly, as it applies to whoever reads it. */
function WhoSees({ org, standing }: { org: Org; standing: Standing }): ReactNode {
  const them = runs(standing) && !standing.staff;
  return (
    <Notice
      tone="neutral"
      icon="eye"
      className="org-about-sees"
      title={them ? "What you can see" : "What owners and admins can see"}
    >
      {them
        ? (
          <>
            As {standing.role === "owner" ? "an owner" : "an admin"}, you reach everything in{" "}
            {org.name}: every space, Personal ones included, with their conversations, agents,
            computers and memories. It's there so you can help, and hand work over when someone
            leaves. People's Personal spaces are still theirs.
          </>
        )
        : (
          <>
            {org.name}'s owners and admins reach everything in it: every space, Personal ones
            included, with their conversations, agents, computers and memories. It's there so they
            can help, and hand work over when someone leaves. Platform staff can come in too; what
            they do is on {org.name}'s record.
          </>
        )}
    </Notice>
  );
}

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

/** The org's name, changed in place by its owners (and staff): the switcher follows. */
function Rename({ org, owner, call }: { org: Org; owner: boolean; call: Call }): ReactNode {
  const [name, setName] = useState(org.name);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ error?: string; saved?: boolean }>({});
  useEffect(() => setName(org.name), [org.name]);
  const changed = !!name.trim() && name.trim() !== org.name;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed || busy) return;
    setBusy(true);
    try {
      await call("org.rename", { name: name.trim() });
      await refreshOrgs();
      setSaid({ saved: true });
    } catch (e) {
      setSaid({ error: message(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="space-setting-form" onSubmit={save}>
      <div className="space-setting-inline">
        <Input
          value={name}
          maxLength={80}
          disabled={!owner}
          autoComplete="off"
          aria-label="The org's name"
          invalid={!!said.error}
          onChange={(event) => {
            setName(event.target.value);
            setSaid({});
          }}
        />
        {owner
          ? (
            <Button type="submit" variant="primary" loading={busy} disabled={!changed}>
              Save
            </Button>
          )
          : null}
      </div>
      {said.error
        ? <p className="space-setting-note space-invite-error" role="alert">{said.error}</p>
        : said.saved
        ? (
          <p className="space-setting-note space-invite-done" role="status">
            <Icon name="check" size={14} />
            Saved. Everyone in it sees the new name.
          </p>
        )
        : null}
    </form>
  );
}
