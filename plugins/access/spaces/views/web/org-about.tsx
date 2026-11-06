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
  lang,
  message,
  Notice,
} from "../../../../../hosts/web/mod.ts";
import { refreshOrgs } from "../../../directory/contract.ts";
import {
  ORG_ROLES,
  orgRoleName,
  runs,
  type Standing,
} from "../../../../interfaces/web/contract.ts";
import { STYLE } from "./style.ts";
import { say } from "./words.ts";

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
      <Card
        as="section"
        padding="none"
        className="space-setting-list"
        aria-label={say("aboutLabel")}
      >
        <Setting
          title={say("name")}
          text={personal
            ? say("orgNamePersonal")
            : owner
            ? say("orgNameOwner")
            : say("orgNameOthers")}
        >
          {personal
            ? <Input value={say("personal")} disabled aria-label={say("orgNameLabel")} />
            : <Rename org={org} owner={owner} call={call} />}
        </Setting>
        <Setting
          title={say("yourRole")}
          text={standing.staff ? say("staffRole") : role?.lets ?? ""}
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
                  {say("staff")}
                </Badge>
              )}
          </span>
        </Setting>
      </Card>
      {personal ? null : <WhoSees org={org} standing={standing} />}
      <Card as="section" className="space-setting-about" aria-labelledby="org-facts">
        <h3 id="org-facts" className="space-section-title">{say("details")}</h3>
        <dl className="space-facts">
          <dt>{say("kind")}</dt>
          <dd>{personal ? say("kindPersonal") : say("kindTeam")}</dd>
          <dt>{say("roles")}</dt>
          <dd className="org-about-roles">
            {ORG_ROLES.map((r) => (
              <span key={r.value}>
                {say.nodes("orgRoleLine", {
                  role: <b>{r.label}</b>,
                  lets: r.lets.charAt(0).toLocaleLowerCase(lang()) + r.lets.slice(1),
                })}
              </span>
            ))}
          </dd>
          <dt>{say("id")}</dt>
          <dd className="space-facts-id">
            <code>{org.id}</code>
            <CopyButton text={org.id} label={say("copyOrgId")} />
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
      title={them ? say("seesYou") : say("seesOwners")}
    >
      {them
        ? say(standing.role === "owner" ? "seesAsOwner" : "seesAsAdmin", { org: org.name })
        : say("seesTheirs", { org: org.name })}
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
          aria-label={say("orgNameLabel")}
          invalid={!!said.error}
          onChange={(event) => {
            setName(event.target.value);
            setSaid({});
          }}
        />
        {owner
          ? (
            <Button type="submit" variant="primary" loading={busy} disabled={!changed}>
              {say("save")}
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
            {say("orgSaved")}
          </p>
        )
        : null}
    </form>
  );
}
