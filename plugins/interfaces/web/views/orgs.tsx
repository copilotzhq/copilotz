/// <reference lib="dom" />
/**
 * Orgs in the shell, when the app serves many (`useOrgs`): the switcher at
 * the top of the sidebar, where the app's identity sits (the org you're in,
 * your standing there; opened, your orgs, Personal first-class, invitations
 * waiting with a badge, to join or decline in place, a new org, the org's
 * settings, and for staff, every org), the small dialog that makes an org,
 * and going between them: a short transition while the page starts over in
 * the other org, and a word once it's there. Staff in an org that isn't
 * theirs see it, quietly and all the time: what they do is on its record.
 */
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import {
  answerOrgInvite,
  arrived,
  Avatar,
  Badge,
  Button,
  createOrg,
  Dialog,
  enterOrg,
  Field,
  Icon,
  Input,
  message,
  type Org,
  type OrgInvite,
  orgName,
  type Orgs,
  type PaletteGroup,
  type PaletteItem,
  type PaletteStep,
  Popover,
  Spinner,
  type Switching,
  Time,
  useSwitching,
} from "../../../../hosts/web/mod.ts";
import { orgRoleName, runs, type Standing, standingName } from "../shared/orgs.ts";

/** An org's face: yours (Personal) is you; a team's, its initials. */
export function OrgFace(
  { org, person, size = 26 }: {
    org: Pick<Org, "name" | "kind"> & { id?: string };
    person: string;
    size?: number;
  },
): ReactNode {
  return org.kind === "personal"
    ? <Avatar name={person} size={size} />
    : <Avatar name={org.name} kind="org" size={size} {...(org.id ? { tint: org.id } : {})} />;
}

/** What the switcher says under the org's name: your standing there. */
function subline(org: Org | undefined, standing: Standing | undefined, staff: boolean) {
  if (staff) return "Staff access";
  if (org?.kind === "personal") return "Just you";
  return standingName(standing) || " ";
}

export function OrgSwitcher(
  { orgs, here, standing, staff, onNew }: {
    orgs: Orgs;
    /** The org the person is in. */
    here?: Org;
    standing?: Standing;
    /** In it as platform staff. */
    staff: boolean;
    /** Opens the dialog that makes one. */
    onNew(): void;
  },
): ReactNode {
  const waiting = orgs.invites.length;
  const name = here ? orgName(here) : "Organization";
  const mine = [...orgs.orgs].sort((a, b) =>
    Number(b.kind === "personal") - Number(a.kind === "personal") ||
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
  return (
    <Popover
      label="Your organizations"
      width={312}
      className="copilotz-orgs"
      trigger={(props) => (
        <button
          type="button"
          {...props}
          className="copilotz-org"
          data-staff={staff || undefined}
          title={staff
            ? `You're in ${name} as platform staff: what you do is on its record`
            : `${name}: switch organization`}
        >
          {here
            ? <OrgFace org={here} person={orgs.person} size={28} />
            : <Avatar name={name} kind="org" size={28} />}
          <span className="copilotz-org-text">
            <span className="copilotz-org-name">{name}</span>
            <span className="copilotz-org-sub">
              {staff ? <Icon name="shield" size={12} /> : null}
              {subline(here, standing, staff)}
            </span>
          </span>
          {waiting
            ? (
              <span className="copilotz-org-dot" aria-label={`${waiting} invitations`}>
                {waiting}
              </span>
            )
            : null}
          <Icon name="selector" size={15} className="copilotz-org-chevron" />
        </button>
      )}
    >
      {(close) => (
        <div className="copilotz-orgs-box">
          <p className="copilotz-orgs-who">
            Signed in as <b>{orgs.email ?? orgs.person}</b>
          </p>
          {staff && here
            ? (
              <div className="copilotz-orgs-staff">
                <Icon name="shield" size={15} />
                <span>
                  You're in <b>{here.name}</b> as staff. What you do here is on its record.
                </span>
              </div>
            )
            : null}
          <ul className="copilotz-orgs-list" aria-label="Organizations">
            {mine.map((org) => (
              <li key={org.id}>
                <OrgRow
                  org={org}
                  person={orgs.person}
                  current={org.id === orgs.current}
                  close={close}
                />
              </li>
            ))}
          </ul>
          {waiting
            ? (
              <section className="copilotz-orgs-invites" aria-labelledby="copilotz-orgs-invites">
                <h3 id="copilotz-orgs-invites">
                  Invitations <Badge tone="primary">{waiting}</Badge>
                </h3>
                <ul>
                  {orgs.invites.map((invite) => (
                    <li key={invite.id}>
                      <InviteRow invite={invite} close={close} />
                    </li>
                  ))}
                </ul>
              </section>
            )
            : null}
          <div className="copilotz-orgs-actions">
            <button
              type="button"
              data-popover-item
              className="copilotz-orgs-action"
              onClick={() => {
                close();
                onNew();
              }}
            >
              <span className="copilotz-orgs-icon copilotz-orgs-icon-new">
                <Icon name="plus" size={15} />
              </span>
              New organization…
            </button>
            {here && (runs(standing) || standing?.role)
              ? (
                <a
                  data-popover-item
                  className="copilotz-orgs-action"
                  href="/org"
                  onClick={close}
                >
                  <span className="copilotz-orgs-icon">
                    <Icon name="settings" size={15} />
                  </span>
                  {runs(standing) ? "Organization settings" : "About this organization"}
                </a>
              )
              : null}
            {orgs.staff
              ? (
                <a
                  data-popover-item
                  className="copilotz-orgs-action"
                  href="/console"
                  onClick={close}
                >
                  <span className="copilotz-orgs-icon">
                    <Icon name="server" size={15} />
                  </span>
                  All orgs (console)
                </a>
              )
              : null}
          </div>
        </div>
      )}
    </Popover>
  );
}

/** One of your orgs: going into it, or where you are (a check). A suspended one says so. */
function OrgRow(
  { org, person, current, close }: {
    org: Org;
    person: string;
    current: boolean;
    close(): void;
  },
): ReactNode {
  const [error, setError] = useState<string>();
  const suspended = !!org.suspended && !current;
  return (
    <button
      type="button"
      data-popover-item
      className="copilotz-orgs-row"
      aria-current={current || undefined}
      aria-disabled={suspended || undefined}
      title={suspended ? `${org.name} is suspended: nobody goes in for now` : undefined}
      onClick={() => {
        if (suspended) return;
        if (current) return close();
        setError(undefined);
        const going = enterOrg(org);
        close();
        going.catch((e) => setError(message(e)));
      }}
    >
      <OrgFace org={org} person={person} size={28} />
      <span className="copilotz-orgs-row-text">
        <span className="copilotz-orgs-row-name">{orgName(org)}</span>
        {error
          ? <span className="copilotz-orgs-row-error">{error}</span>
          : org.kind === "personal"
          ? <span className="copilotz-orgs-row-sub">Your own</span>
          : null}
      </span>
      {suspended ? <Badge tone="warning">Suspended</Badge> : null}
      {current ? <Icon name="check" size={16} className="copilotz-orgs-check" /> : null}
    </button>
  );
}

/** An invitation to an org, answered in place: joining goes into it. */
function InviteRow({ invite, close }: { invite: OrgInvite; close(): void }): ReactNode {
  const [busy, setBusy] = useState<"join" | "decline">();
  const [error, setError] = useState<string>();
  const answer = (accept: boolean) => {
    setBusy(accept ? "join" : "decline");
    setError(undefined);
    const answered = answerOrgInvite(invite, accept);
    // Joining goes into it: the transition shows over everything.
    if (accept) close();
    answered.catch((e) => {
      setError(message(e));
      setBusy(undefined);
    });
  };
  return (
    <div className="copilotz-orgs-invite">
      <Avatar name={invite.name} kind="org" size={28} tint={invite.org} />
      <div className="copilotz-orgs-invite-text">
        <p className="copilotz-orgs-invite-name">{invite.name}</p>
        <p className="copilotz-orgs-invite-meta">
          {error ?? (
            <>
              {invite.from ? `${invite.from} invited you` : "You're invited"}, as{" "}
              {orgRoleName(invite.role).toLowerCase()} · <Time at={invite.at} />
            </>
          )}
        </p>
        <div className="copilotz-orgs-invite-answers">
          <Button
            size="sm"
            variant="primary"
            data-popover-item
            loading={busy === "join"}
            disabled={!!busy}
            onClick={() => answer(true)}
          >
            Join
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-popover-item
            loading={busy === "decline"}
            disabled={!!busy}
            onClick={() => answer(false)}
          >
            Decline
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Names longer than this aren't taken. */
const LONGEST = 80;

/** The small dialog that makes a team org: its name, then you're in it, its owner. */
export function NewOrg({ open, onClose }: { open: boolean; onClose(): void }): ReactNode {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) {
      setName("");
      setError(undefined);
      setBusy(false);
    }
  }, [open]);
  const typed = name.trim();
  const long = typed.length > LONGEST;
  const create = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!typed || long || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await createOrg(typed);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="New organization"
      description="For a team: you'll own it, and invite people by email."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!typed || long}
            onClick={() => void create()}
          >
            Create organization
          </Button>
        </>
      }
    >
      <form onSubmit={create} className="copilotz-new-org">
        <div className="copilotz-new-org-preview" aria-hidden="true">
          <Avatar name={typed || "?"} kind="org" size={44} />
        </div>
        <Field
          label="Name"
          hint={long
            ? undefined
            : "Usually your team's or company's name. You can change it later."}
          error={long ? `At most ${LONGEST} characters` : error}
        >
          {(control) => (
            <Input
              {...control}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Acme"
              autoComplete="organization"
              maxLength={LONGEST + 20}
              autoFocus
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

/** While the page goes into another org: its face and name, over everything, until it's there. */
export function Switching(): ReactNode {
  const to = useSwitching();
  const [welcome, setWelcome] = useState<Switching>();
  const layer = useRef<HTMLDialogElement>(null);
  // Over everything, a dialog that started it included: a modal of its own, on top.
  useEffect(() => {
    if (to && !layer.current?.open) layer.current?.showModal();
  }, [to]);
  useEffect(() => {
    const came = arrived();
    if (!came) return;
    setWelcome(came);
    const done = setTimeout(
      () => setWelcome(undefined),
      came.staff || came.moved ? 5200 : 2600,
    );
    return () => clearTimeout(done);
  }, []);
  return (
    <>
      {to
        ? (
          <dialog
            ref={layer}
            className="copilotz-switching"
            aria-live="assertive"
            aria-label={`Going into ${orgName(to)}`}
            // It ends when the page starts over, not on Escape.
            onCancel={(event) => event.preventDefault()}
          >
            <div className="copilotz-switching-box">
              {to.kind === "personal"
                ? (
                  <span className="copilotz-switching-personal">
                    <Icon name="person" size={26} />
                  </span>
                )
                : (
                  <Avatar
                    name={to.name}
                    kind="org"
                    size={56}
                    {...(to.id ? { tint: to.id } : {})}
                  />
                )}
              <p className="copilotz-switching-label">
                {to.staff ? "Entering as staff" : "Switching to"}
              </p>
              <p className="copilotz-switching-name">{orgName(to)}</p>
              <Spinner variant="dots" size={6} />
            </div>
          </dialog>
        )
        : null}
      {welcome && !to
        ? (
          <div
            className="copilotz-arrived"
            role="status"
            data-staff={welcome.staff || undefined}
            data-long={welcome.staff || welcome.moved || undefined}
          >
            {welcome.staff
              ? <Icon name="shield" size={16} />
              : <Icon name={welcome.moved ? "info" : "check"} size={16} />}
            <span>
              {welcome.staff
                ? (
                  <>
                    You're in <b>{welcome.name}</b> as staff. What you do here is on its record.
                  </>
                )
                : welcome.moved
                ? (
                  <>
                    You're no longer in the org you were in. You're in <b>{orgName(welcome)}</b>.
                  </>
                )
                : (
                  <>
                    You're in <b>{orgName(welcome)}</b>
                  </>
                )}
            </span>
          </div>
        )
        : null}
    </>
  );
}

/** Making a team org from the palette: its name, then you're in it. */
const newOrgStep: PaletteStep = {
  title: "New organization",
  placeholder: "Name it",
  note: "For a team: you'll own it, and invite people by email.",
  filter: false,
  items: (search) => {
    const name = search.trim();
    if (!name) return [];
    const long = name.length > LONGEST;
    return [{
      title: "",
      items: [{
        key: "org:create",
        label: `Create “${name}”`,
        icon: "plus",
        disabled: long,
        ...(long ? { description: `At most ${LONGEST} characters` } : {}),
        run: () => createOrg(name),
      }],
    }];
  },
};

/**
 * What the palette offers for orgs: the others to switch to, invitations to
 * join or decline (with the spaces' own, under one heading), a new org, the
 * org's settings, and for staff, every org.
 */
export function orgsPalette(
  orgs: Orgs,
  here: Org | undefined,
  standing: Standing | undefined,
): PaletteGroup[] {
  const others = orgs.orgs.filter((o) => o.id !== orgs.current);
  const groups: PaletteGroup[] = [{
    title: "Organizations",
    order: 25,
    items: [
      ...others.map((org): PaletteItem => ({
        key: `org:${org.id}`,
        label: `Switch to ${orgName(org)}`,
        leading: <OrgFace org={org} person={orgs.person} size={26} />,
        ...(org.suspended
          ? { description: "Suspended", disabled: true }
          : org.kind === "personal"
          ? { description: "Your own org" }
          : {}),
        keywords: ["organization", "org", "switch", org.name],
        run: () => enterOrg(org),
      })),
      {
        key: "org:new",
        label: "New organization…",
        icon: "plus",
        keywords: ["create", "team", "organization", "org"],
        step: newOrgStep,
      },
      ...(here
        ? [{
          key: "org:settings",
          label: runs(standing) ? "Organization settings" : "About this organization",
          icon: "settings" as const,
          keywords: ["members", "usage", "invite", "roles", "organization"],
          href: "/org",
        }]
        : []),
      ...(orgs.staff
        ? [{
          key: "org:console",
          label: "All orgs (console)",
          icon: "server" as const,
          keywords: ["staff", "console", "platform", "suspend"],
          href: "/console",
        }]
        : []),
    ],
  }];
  if (orgs.invites.length) {
    groups.unshift({
      title: "Invitations",
      order: 5,
      items: orgs.invites.flatMap((invite): PaletteItem[] => [
        {
          key: `org-invite:${invite.id}`,
          label: `Join ${invite.name}`,
          leading: <Avatar name={invite.name} kind="org" size={26} tint={invite.org} />,
          description: `${invite.from ? `${invite.from} invited you` : "You're invited"}, as ${
            orgRoleName(invite.role).toLowerCase()
          }`,
          keywords: ["invitation", "accept", "organization"],
          run: () => answerOrgInvite(invite, true),
        },
        {
          key: `org-decline:${invite.id}`,
          label: `Decline ${invite.name}'s invitation`,
          icon: "close",
          keywords: ["invitation", "organization"],
          run: () => answerOrgInvite(invite, false),
        },
      ]),
    });
  }
  return groups;
}
