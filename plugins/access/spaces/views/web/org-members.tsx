/**
 * The org's people (kind `org.members`, a section of the org's page, the web
 * shell's `orgSettings`), where the app serves many orgs: who's in it, with
 * their role, name, email and face (`org.people`), you first. Its owners and
 * admins invite people by email with a role (`org.invite`), see the
 * invitations waiting and take one back (`org.invites`, `org.uninvite`),
 * change roles (`org.role`: only owners make or unmake owners, and the last
 * owner stays one) and take someone out (`org.remove`), choosing who gets
 * the spaces only they managed. Members see who's in it. It follows the
 * org's memberships as they change: someone joining shows at once.
 */
import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  Icon,
  Input,
  Menu,
  message,
  Notice,
  Select,
  Skeleton,
  Time,
} from "../../../../../hosts/web/mod.ts";
import {
  ORG_ROLES,
  orgRoleName,
  runs,
  type Standing,
} from "../../../../interfaces/web/contract.ts";
import type { Member, Reached } from "../../contract.ts";
import { nameOf } from "../../shared/names.ts";
import { ORG } from "../../shared/reach.ts";
import { STYLE } from "./style.ts";
import { addressesOf, EMAIL, listed } from "./who.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** Someone in the org, as `org.people` answers. */
type Person = { person: string; role: string; name?: string; email?: string; picture?: string };
/** An invitation to the org, as `org.invites` answers. */
type Invite = { id: string; email: string; role: string; at: string };

type Org = { id: string; name: string; kind: string };

export const orgMembersView = (_item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const style = <style href="spaces-web" precedence="copilotz">{STYLE}</style>;
  // The org's memberships, as the rules let the person read them: what's followed.
  const members = ctx.db.collection<Member>("member").find({ space: ORG }).value;
  const spaces = ctx.db.collection("space").query<Reached[]>("reached", {}).value;
  const org = ctx.hints.org as Org | undefined;
  const standing = {
    role: (ctx.hints.role as string | null | undefined) ?? null,
    staff: ctx.hints.staff === true,
  };
  if (members === undefined || !org) {
    return (
      <div className="space-members" aria-busy="true">
        {style}
        {[0, 1, 2].map((i) => <Skeleton key={i} height={56} radius="lg" />)}
      </div>
    );
  }
  // What changed: someone in or out, a role. People are asked again then.
  const signature = members.map((m) => `${m.member}=${m.role}`).sort().join(",");
  return (
    <>
      {style}
      <People
        org={org}
        standing={standing}
        signature={signature}
        spaces={spaces ?? []}
        me={ctx.viewer?.name}
        call={ctx.call}
      />
    </>
  );
};

function People(
  { org, standing, signature, spaces, me, call }: {
    org: Org;
    standing: Standing;
    signature: string;
    spaces: Reached[];
    me?: string;
    call: Call;
  },
): ReactNode {
  const manage = runs(standing);
  const personal = org.kind === "personal";
  const [people, setPeople] = useState<Person[]>();
  const [invites, setInvites] = useState<Invite[]>();
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState<Person>();
  const [note, setNote] = useState<string>();
  const [asked, ask] = useState(0);
  useEffect(() => {
    let current = true;
    call<{ people: Person[] }>("org.people", {}).then(
      (found) => current && (setPeople(found.people), setError(undefined)),
      (e) => current && setError(message(e)),
    );
    if (manage && !personal) {
      call<{ invites: Invite[] }>("org.invites", {}).then(
        (found) => current && setInvites(found.invites),
        () => current && setInvites([]),
      );
    }
    return () => {
      current = false;
    };
  }, [signature, asked, manage]);
  useEffect(() => {
    if (!note) return;
    const gone = setTimeout(() => setNote(undefined), 6000);
    return () => clearTimeout(gone);
  }, [note]);

  if (error && !people) return <Notice tone="destructive" role="alert">{error}</Notice>;
  if (!people) {
    return (
      <div className="space-members" aria-busy="true">
        {[0, 1, 2].map((i) => <Skeleton key={i} height={56} radius="lg" />)}
      </div>
    );
  }
  const sorted = [...people].sort((a, b) => Number(b.person === me) - Number(a.person === me));
  const owners = people.filter((p) => p.role === "owner");
  const spaceName = (id: string) => spaces.find((s) => s._id === id)?.name ?? id;
  return (
    <div className="space-members org-members">
      {personal
        ? (
          <Notice tone="neutral" icon="person">
            A personal org is yours alone. To work with others, make a team org (New organization,
            in the switcher) and invite them there.
          </Notice>
        )
        : null}
      {manage && !personal
        ? (
          <section className="space-section" aria-labelledby="org-invite">
            <h3 id="org-invite" className="space-section-title">Invite people</h3>
            <OrgInviteForm org={org} call={call} sent={() => ask((n) => n + 1)} />
          </section>
        )
        : null}
      {note
        ? (
          <Notice tone="success" role="status" className="org-note">
            {note}
          </Notice>
        )
        : null}
      <section className="space-section" aria-labelledby="org-people">
        <h3 id="org-people" className="space-section-title">
          People <span className="space-count">{people.length}</span>
        </h3>
        <ul className="space-rows">
          {sorted.map((p) => (
            <Row
              key={p.person}
              person={p}
              mine={p.person === me}
              standing={standing}
              lastOwner={p.role === "owner" && owners.length === 1}
              call={call}
              remove={() => setRemoving(p)}
              changed={() => ask((n) => n + 1)}
            />
          ))}
        </ul>
      </section>
      {manage && invites?.length
        ? (
          <section className="space-section" aria-labelledby="org-invited">
            <h3 id="org-invited" className="space-section-title">
              Invited <span className="space-count">{invites.length}</span>
            </h3>
            <ul className="space-rows">
              {invites.map((i) => (
                <InviteRow
                  key={i.id}
                  invite={i}
                  call={call}
                  gone={() => ask((n) => n + 1)}
                />
              ))}
            </ul>
          </section>
        )
        : null}
      {manage
        ? (
          <RemoveDialog
            org={org}
            person={removing}
            people={people}
            me={me}
            call={call}
            close={() => setRemoving(undefined)}
            removed={(who, handed) => {
              setRemoving(undefined);
              ask((n) => n + 1);
              setNote(
                handed.length
                  ? `${who} is out of ${org.name}. ${
                    handed.length === 1 ? "A space" : `${handed.length} spaces`
                  } only they managed went on: ${listed(handed.map(spaceName))}.`
                  : `${who} is out of ${org.name}.`,
              );
            }}
          />
        )
        : null}
    </div>
  );
}

/** What someone's called where they show: their name, else their email (never a sign-in's id). */
const named = (p: Person) => p.name || p.email || nameOf(p.person);

function Row(
  { person: p, mine, standing, lastOwner, call, remove, changed }: {
    person: Person;
    mine: boolean;
    standing: Standing;
    lastOwner: boolean;
    call: Call;
    remove(): void;
    changed(): void;
  },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const owner = standing.staff || standing.role === "owner";
  const manage = runs(standing);
  // An admin changes everyone but owners; an owner, everyone; the last owner stays one.
  const changes = manage && (owner || p.role !== "owner") && !lastOwner;
  const removes = manage && (owner || p.role !== "owner") && !lastOwner && !mine;
  const roles = ORG_ROLES.filter((r) => owner || r.value !== "owner");
  const name = named(p);
  const setRole = async (role: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await call("org.role", { person: p.person, role });
      changed();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card as="li" padding="none" className="space-row org-row">
      <Avatar name={name} picture={p.picture} size={34} />
      <div className="space-row-text">
        <p className="space-row-name">
          <span className="org-row-name">{name}</span>
          {mine ? <Badge tone="primary">You</Badge> : null}
        </p>
        <p className="space-row-what">
          {error ?? (p.email && p.email !== name ? p.email : "")}
        </p>
      </div>
      <div className="space-row-end">
        {changes
          ? (
            <Select
              size="sm"
              value={p.role}
              disabled={busy}
              aria-label={`${name}'s role`}
              title={ORG_ROLES.find((r) => r.value === p.role)?.lets}
              onChange={(event) => void setRole(event.target.value)}
            >
              {roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </Select>
          )
          : (
            <Badge
              variant="outline"
              title={lastOwner
                ? "The org's only owner: make someone else an owner first"
                : ORG_ROLES.find((r) => r.value === p.role)?.lets}
            >
              {orgRoleName(p.role)}
            </Badge>
          )}
        {removes
          ? (
            <Menu
              label={`${name}: more`}
              align="end"
              size="sm"
              items={[{
                label: `Remove from the org…`,
                icon: "signout",
                tone: "destructive",
                onSelect: remove,
              }]}
            />
          )
          : manage
          ? <span className="org-row-spacer" aria-hidden="true" />
          : null}
      </div>
    </Card>
  );
}

/** Inviting people by email, with a role: admins, members or guests (owners are made, later). */
function OrgInviteForm(
  { org, call, sent }: { org: Org; call: Call; sent(): void },
): ReactNode {
  const [typed, setTyped] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const id = useId();
  const emails = addressesOf(typed);
  const ready = emails.length > 0 && emails.every((e) => EMAIL.test(e));
  const roles = ORG_ROLES.filter((r) => r.value !== "owner");
  const lets = roles.find((r) => r.value === role)?.lets;
  // What inviting did, said a while; then the form says what the role lets again.
  useEffect(() => {
    if (!done) return;
    const gone = setTimeout(() => setDone(undefined), 8000);
    return () => clearTimeout(gone);
  }, [done]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(undefined);
    const done: string[] = [];
    try {
      for (const email of emails) {
        await call("org.invite", { email, role });
        done.push(email);
      }
      setTyped("");
    } catch (e) {
      setTyped(emails.filter((e) => !done.includes(e)).join(", "));
      setError(message(e));
    } finally {
      setDone(
        done.length
          ? `Invited ${listed(done)} to ${org.name}. ${
            done.length === 1 ? "They'll join" : "Each joins"
          } once they accept, signed in with that email.`
          : undefined,
      );
      setBusy(false);
      if (done.length) sent();
    }
  };
  return (
    <form className="space-invite" onSubmit={submit}>
      <div className="space-invite-row">
        <label className="copilotz-sr" htmlFor={`${id}-email`}>Their email</label>
        <Input
          id={`${id}-email`}
          type="text"
          inputMode="email"
          icon="mail"
          value={typed}
          maxLength={2000}
          placeholder="name@example.com"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          invalid={!!error}
          aria-describedby={`${id}-note`}
          onChange={(event) => {
            setTyped(event.target.value);
            setDone(undefined);
            setError(undefined);
          }}
        />
        <label className="copilotz-sr" htmlFor={`${id}-role`}>Their role</label>
        <Select id={`${id}-role`} value={role} onChange={(event) => setRole(event.target.value)}>
          {roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </Select>
        <Button type="submit" variant="primary" icon="invite" loading={busy} disabled={!ready}>
          Invite
        </Button>
      </div>
      <p id={`${id}-note`} className="space-invite-note" aria-live="polite">
        {error
          ? <span className="space-invite-error" role="alert">{error}</span>
          : done
          ? (
            <span className="space-invite-done">
              <Icon name="check" size={14} />
              {done}
            </span>
          )
          : (
            <span>
              {lets}. {emails.length > 1
                ? `${emails.length} addresses.`
                : "Several? Separate them with commas."}
            </span>
          )}
      </p>
    </form>
  );
}

function InviteRow({ invite: i, call, gone }: { invite: Invite; call: Call; gone(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Card as="li" padding="none" className="space-row space-row-invited">
      <span className="space-row-mark space-row-mail">
        <Icon name="mail" size={15} />
      </span>
      <div className="space-row-text">
        <p className="space-row-name">
          <span className="space-row-email">{i.email}</span>
          <Badge variant="outline">{orgRoleName(i.role)}</Badge>
        </p>
        <p className="space-row-what">
          {error ?? (
            <>
              Invited <Time at={i.at} long />
            </>
          )}
        </p>
      </div>
      <div className="space-row-end">
        <Button
          size="sm"
          variant="ghost"
          loading={busy}
          aria-label={`Take back the invitation to ${i.email}`}
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              await call("org.uninvite", { email: i.email });
              gone();
            } catch (e) {
              setError(message(e));
              setBusy(false);
            }
          }}
        >
          Take back
        </Button>
      </div>
    </Card>
  );
}

/**
 * Taking someone out: what it means (their sessions end, they leave every
 * space; their Personal space stays, where admins reach it), and who gets
 * the shared spaces only they managed: you, or someone who stays.
 */
function RemoveDialog(
  { org, person, people, me, call, close, removed }: {
    org: Org;
    person?: Person;
    people: Person[];
    me?: string;
    call: Call;
    close(): void;
    removed(name: string, handed: string[]): void;
  },
): ReactNode {
  const [to, setTo] = useState(me ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setTo(me && people.some((p) => p.person === me) ? me : "");
    setBusy(false);
    setError(undefined);
  }, [person]);
  // Who can take their spaces: anyone who stays, but guests.
  const heirs = people.filter((p) => p.person !== person?.person && p.role !== "guest");
  const name = person ? named(person) : "";
  const go = async () => {
    if (!person) return;
    setBusy(true);
    setError(undefined);
    try {
      const { handed } = await call<{ handed: string[] }>("org.remove", {
        person: person.person,
        ...(to ? { to } : {}),
      });
      removed(name, handed ?? []);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!person}
      onClose={close}
      title={`Remove ${name} from ${org.name}?`}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
          <Button variant="destructive" loading={busy} onClick={() => void go()}>
            Remove {name}
          </Button>
        </>
      }
    >
      <div className="org-remove">
        <ul className="org-remove-means">
          <li>
            <Icon name="signout" size={15} />
            <span>
              They're signed out of {org.name}{" "}
              at once, wherever they are, and leave every space in it.
            </span>
          </li>
          <li>
            <Icon name="person" size={15} />
            <span>
              Their Personal space stays, as it is: the org's owners and admins still reach it.
            </span>
          </li>
        </ul>
        <Field
          label="Shared spaces only they manage go to"
          hint="They become its manager there. Spaces others manage too stay as they are."
        >
          {(control) => (
            <Select
              {...control}
              value={to}
              onChange={(event) => setTo(event.target.value)}
            >
              {!me || !people.some((p) => p.person === me) ? <option value="">You</option> : null}
              {heirs.map((p) => (
                <option key={p.person} value={p.person}>
                  {p.person === me ? `You (${named(p)})` : named(p)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      </div>
    </Dialog>
  );
}
