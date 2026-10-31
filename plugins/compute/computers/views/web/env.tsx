/**
 * A space's environment (kind `env.space`: its Environment tab, spaces'
 * `spaceTabs`; item `{ _id }`, the space): its variables and secrets
 * (`envVar.here`), by name, each with its value (a secret's never: that
 * it's there, sealed, and a long one's last characters), whether its
 * computers' jobs and shells get it (its apps always do), who set it and
 * when. Those who manage the space add, change and remove them (`env.set`,
 * `env.unset`); a secret given to computers says what that means: any
 * process there can read it. Under it, what other front ends add
 * (`envActions`: its apps, given it again). In a side panel, the same,
 * compact.
 */
import { type ReactNode, useId, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Button,
  Card,
  Checkbox,
  CopyButton,
  Dialog,
  EmptyState,
  Field,
  Icon,
  IconButton,
  Input,
  LazyView,
  message,
  Notice,
  Skeleton,
  Textarea,
  Time,
} from "../../../../../hosts/web/mod.ts";
import type { Reached } from "../../../../access/spaces/contract.ts";
import type { EnvVar } from "../../collections/env-var.ts";
import type { EnvChanged } from "../../contract.ts";
import { nameProblem, oneLine, typedName } from "./environment.ts";
import { type EnvAction, envActionsOf } from "./kinds.ts";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export const envSpaceView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const id = item._id ?? (typeof ctx.hints.in === "string" ? ctx.hints.in : "");
  const vars = ctx.db.collection("envVar").query<EnvVar[]>("here", { in: id }).value;
  const spaces = ctx.db.collection("space").query<Reached[]>("reached", {}).value;
  const compact = ctx.hints.mode === "panel";
  const style = <style href="computers-web" precedence="copilotz">{STYLE}</style>;
  if (vars === undefined || spaces === undefined) {
    return (
      <div className="env" aria-busy="true">
        {style}
        <Skeleton height={40} radius="lg" width={compact ? "100%" : 420} />
        <Skeleton height={compact ? 160 : 220} radius="xl" />
      </div>
    );
  }
  const space = spaces.find((s) => s._id === id);
  if (!space) return null;
  return (
    <>
      {style}
      <Environment
        key={space._id}
        space={space}
        vars={vars}
        me={ctx.viewer?.name}
        compact={compact}
        call={ctx.call}
        actions={envActionsOf(ctx.resources.envActions)}
      />
    </>
  );
};

/** A space as its environment's words say it. */
const whereOf = (space: Reached) => space.kind === "personal" ? "your personal space" : space.name;

/** Which one is being changed (none: a new one), opened afresh each time. */
type Editing = { var?: EnvVar; at: number };

export function Environment(
  { space, vars, me, compact, call, actions }: {
    space: Reached;
    vars: EnvVar[];
    me?: string;
    compact: boolean;
    call: Call;
    actions: (EnvAction & { key: string })[];
  },
): ReactNode {
  const [editing, setEditing] = useState<Editing>();
  const [removing, setRemoving] = useState<EnvVar>();
  const [changed, setChanged] = useState<string>();
  const manage = space.can.includes("manage");
  const where = whereOf(space);
  const edit = (found?: EnvVar) => setEditing({ ...(found ? { var: found } : {}), at: Date.now() });
  const done = () => setChanged(new Date().toISOString());
  const reached: EnvChanged = { _id: space._id, ...(changed ? { changed } : {}) };
  const secrets = vars.filter((v) => v.secret).length;
  return (
    <div className={`env${compact ? " env-compact" : ""}`}>
      <header className="env-head">
        <p className="env-intro">
          {vars.length
            ? (
              <>
                <strong>
                  {vars.length === 1 ? "One variable" : `${vars.length} variables`}
                  {secrets ? `, ${secrets === vars.length ? "all" : secrets} secret` : ""}.
                </strong>
                {" "}
              </>
            )
            : null}
          Jobs and shells on{" "}
          {where}'s computers start with those given to computers, the agents' too; its published
          apps get them all.
        </p>
        {manage && vars.length
          ? (
            <Button variant="primary" icon="plus" onClick={() => edit()}>
              Add a variable
            </Button>
          )
          : null}
      </header>
      {vars.length
        ? (
          <Card
            as="section"
            padding="none"
            className="env-table"
            aria-label={`${where}'s environment`}
          >
            <ul className="env-list">
              {vars.map((v) => (
                <EnvRow
                  key={v._id}
                  found={v}
                  me={me}
                  manage={manage}
                  edit={() => edit(v)}
                  remove={() => setRemoving(v)}
                />
              ))}
            </ul>
          </Card>
        )
        : (
          <EmptyState
            icon="lock"
            tone="primary"
            title="No variables yet"
            className="env-empty"
            action={manage
              ? (
                <Button variant="primary" icon="plus" onClick={() => edit()}>
                  Add a variable
                </Button>
              )
              : undefined}
          >
            Give this space's jobs, shells and apps what they need to run: an API's address, a key.
            Secrets are sealed when they're saved and never shown again, not even to you; agents see
            only their names.
          </EmptyState>
        )}
      {manage ? null : (
        <Notice tone="neutral" icon="lock">
          You can see{" "}
          {where}'s variables, and which secrets it has; those who manage it change them.
        </Notice>
      )}
      {actions.map((a) => <LazyView key={a.key} kind={a.view} item={reached} fallback={null} />)}
      <EnvDialog
        key={editing?.at ?? 0}
        open={!!editing}
        space={space._id}
        where={where}
        {...(editing?.var ? { editing: editing.var } : {})}
        taken={vars.map((v) => v.name)}
        call={call}
        onClose={() => setEditing(undefined)}
        saved={done}
      />
      <RemoveDialog
        found={removing}
        space={space._id}
        call={call}
        onClose={() => setRemoving(undefined)}
        removed={done}
      />
    </div>
  );
}

function EnvRow(
  { found, me, manage, edit, remove }: {
    found: EnvVar;
    me?: string;
    manage: boolean;
    edit(): void;
    remove(): void;
  },
): ReactNode {
  // A secret its computers get: any process there can read it.
  const exposed = found.secret && found.computers;
  return (
    <li className="env-row" data-secret={found.secret || undefined}>
      <div className="env-key">
        <code className="env-name">{found.name}</code>
        <span className="env-meta">
          {found.by === me ? "you" : found.by} · <Time at={found.at} />
        </span>
      </div>
      <div className="env-value">
        {found.secret
          ? (
            <span className="env-sealed" title="A secret: sealed, never shown">
              <Icon name="lock" size={13} />
              <span aria-hidden="true">{found.hint ?? "••••••••"}</span>
              <span className="copilotz-sr">
                A secret{found.hint ? `, ending ${found.hint.slice(-4)}` : ""}
              </span>
            </span>
          )
          : found.value
          ? (
            <>
              <code className="env-text" title={found.value}>{oneLine(found.value)}</code>
              <CopyButton text={found.value} label={`Copy ${found.name}'s value`} />
            </>
          )
          : <span className="env-blank">empty</span>}
      </div>
      <span
        className="env-where"
        data-exposed={exposed || undefined}
        title={exposed
          ? "Any process on this space's computers can read it"
          : found.computers
          ? "Jobs and shells on this space's computers get it, and its apps"
          : "Only its apps get it"}
      >
        <Icon name={exposed ? "alert" : found.computers ? "computer" : "globe"} size={13} />
        {found.computers ? "Computers and apps" : "Apps only"}
      </span>
      {manage
        ? (
          <span className="env-actions">
            <IconButton icon="pencil" size="sm" label={`Change ${found.name}`} onClick={edit} />
            <IconButton icon="trash" size="sm" label={`Remove ${found.name}`} onClick={remove} />
          </span>
        )
        : null}
    </li>
  );
}

/**
 * Adding a variable, or changing one: its name (fixed, once it's there),
 * its value (a secret's isn't shown: left empty, it's kept), whether it's a
 * secret, and whether the space's computers get it, with what that means
 * for a secret.
 */
function EnvDialog(
  { open, space, where, editing, taken, call, onClose, saved }: {
    open: boolean;
    space: string;
    where: string;
    editing?: EnvVar;
    taken: string[];
    call: Call;
    onClose(): void;
    saved(): void;
  },
): ReactNode {
  const [name, setName] = useState(editing?.name ?? "");
  const [value, setValue] = useState(editing && !editing.secret ? editing.value ?? "" : "");
  const [secret, setSecret] = useState(editing?.secret ?? false);
  const [computers, setComputers] = useState(editing?.computers ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [tried, setTried] = useState(false);
  const id = useId();
  // A secret's value isn't shown: left empty, it stays as it is.
  const keeps = !!editing?.secret && secret && value === "";
  // A variable made a secret, or a secret made a variable, is given its value again.
  const flipped = !!editing && editing.secret !== secret;
  const named = editing ? undefined : nameProblem(name) ??
    (taken.includes(name) ? `There's a ${name} already: change that one.` : undefined);
  const needsValue = (secret && !editing) || (flipped && !secret);
  const unvalued = needsValue && value === "" ? "Type its value." : undefined;
  const submit = async () => {
    setTried(true);
    if (named || unvalued || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await call("env.set", { in: space, name, ...(keeps ? {} : { value }), secret, computers });
      saved();
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? `Change ${editing.name}` : "New variable"}
      description={`In ${where}'s environment.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={`${id}-form`} variant="primary" icon="check" loading={busy}>
            {editing ? "Save" : "Add it"}
          </Button>
        </>
      }
    >
      <form
        id={`${id}-form`}
        className="env-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field
          label="Name"
          error={tried ? named : undefined}
          hint={editing
            ? "Its name stays as it is: to rename it, add it again under the new one."
            : (
              <>
                As programs read it: <code>${name || "API_URL"}</code>
              </>
            )}
        >
          {(control) => (
            <Input
              {...control}
              className="env-form-name"
              value={name}
              placeholder="API_URL"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              disabled={!!editing}
              maxLength={128}
              onChange={(event) => setName(typedName(event.target.value))}
            />
          )}
        </Field>
        <Field
          label="Value"
          error={tried ? unvalued : undefined}
          hint={keeps
            ? (
              <>
                Sealed{editing?.hint
                  ? (
                    <>
                      , ending <code>{editing.hint.slice(-4)}</code>
                    </>
                  )
                  : null}
                : leave this empty to keep it, or type a new one.
              </>
            )
            : secret
            ? "Sealed when it's saved: no one sees it again, not even you."
            : "Anyone in the space can see it."}
        >
          {(control) => (
            <Textarea
              {...control}
              className="env-form-value"
              value={value}
              rows={1}
              autoGrow
              maxHeight={220}
              placeholder={editing?.secret && secret
                ? "•••••••• (kept as it is)"
                : secret
                ? "Paste the secret"
                : "https://api.example.com"}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={32768}
              data-secret={secret || undefined}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
        </Field>
        <div className="env-form-options">
          <Checkbox
            checked={secret}
            onChange={(event) => setSecret(event.target.checked)}
            label={
              <>
                <span className="env-form-option">Secret</span>
                <span className="env-form-option-note">
                  Sealed, never shown again; agents see only its name.
                </span>
              </>
            }
          />
          <Checkbox
            checked={computers}
            onChange={(event) => setComputers(event.target.checked)}
            label={
              <>
                <span className="env-form-option">Give it to this space's computers</span>
                <span className="env-form-option-note">
                  Jobs and shells started there get it, the agents' too. Apps always do.
                </span>
              </>
            }
          />
        </div>
        {secret && computers
          ? (
            <Notice tone="warning" icon="shield" className="env-form-limit">
              Any process on{" "}
              {where}'s computers can read it, an agent's command too, and could print it. Leave it
              off the computers if only apps need it.
            </Notice>
          )
          : null}
        {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      </form>
    </Dialog>
  );
}

/** Removing one, once they've said so: what's running keeps it. */
function RemoveDialog(
  { found, space, call, onClose, removed }: {
    found?: EnvVar;
    space: string;
    call: Call;
    onClose(): void;
    removed(): void;
  },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const close = () => {
    setError(undefined);
    onClose();
  };
  return (
    <Dialog
      open={!!found}
      onClose={close}
      size="sm"
      title={found ? `Remove ${found.name}?` : ""}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="destructive"
            icon="trash"
            loading={busy}
            onClick={async () => {
              if (!found) return;
              setBusy(true);
              try {
                await call("env.unset", { in: space, name: found.name });
                removed();
                close();
              } catch (e) {
                setError(message(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Remove
          </Button>
        </>
      }
    >
      <p className="env-dialog-text">
        Jobs and shells started from now on won't have it; those running keep it. Apps lose it the
        next time they're published.
      </p>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
    </Dialog>
  );
}
