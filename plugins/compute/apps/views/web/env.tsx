/**
 * Apps and their environment on the web. Each app runs with its space's
 * environment (every variable and secret there, not only those its
 * computers get) and its own over it, as it was when it was last deployed.
 *
 * - `AppEnv`: an app's environment, in a dialog from its row: its own,
 *   changed there by its publisher or the space's managers (a secret's
 *   value never shows: left empty, it's kept), over the space's, shown as
 *   they are (changed on the space's Environment tab). Saving deploys it
 *   again with them, without a build (`app.configure`).
 * - `app.env-apply` (computers' `envActions`, item `EnvChanged`): under the
 *   space's environment, its live apps, and giving them the environment as
 *   it is now (each `app.configure`d), most of all once it changed there.
 */
import { type ReactNode, useId, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  Icon,
  IconButton,
  Input,
  message,
  Notice,
  Skeleton,
  Textarea,
} from "../../../../../hosts/web/mod.ts";
import type { EnvChanged, EnvVar } from "../../../computers/contract.ts";
import type { AppDoc } from "../../collections/app.ts";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;
type Place = { _id: string; name: string; kind: string; can?: string[] };

/** What may be named: as the space's environment says. */
const NAME = /^[A-Z_][A-Z0-9_]*$/;
const typed = (name: string) =>
  name.toUpperCase().replace(/[\s.-]/g, "_").replace(/[^A-Z0-9_]/g, "").slice(0, 128);

/** One of an app's own, as it's edited: `had`, as it was (none: new). */
type Row = { key: string; name: string; value: string; secret: boolean; had?: EnvVar };

const rowOf = (had: EnvVar): Row => ({
  key: had._id,
  name: had.name,
  value: had.secret ? "" : had.value ?? "",
  secret: had.secret,
  had,
});

/** A change `app.configure` takes. */
type Change = { name: string; value?: string; secret?: boolean; remove?: boolean };

/** What changed from what it had to the rows: each new or changed one, and those gone. */
export function changesOf(had: EnvVar[], rows: Row[]): Change[] {
  const kept = new Set(rows.flatMap((r) => r.had ? [r.had.name] : []));
  const gone = had.filter((h) => !kept.has(h.name)).map((h) => ({ name: h.name, remove: true }));
  const changed = rows.flatMap((r): Change[] => {
    if (!r.had) return [{ name: r.name, value: r.value, secret: r.secret }];
    if (r.secret !== r.had.secret) return [{ name: r.name, value: r.value, secret: r.secret }];
    if (r.secret) return r.value ? [{ name: r.name, value: r.value }] : [];
    return r.value !== (r.had.value ?? "") ? [{ name: r.name, value: r.value }] : [];
  });
  return [...gone, ...changed];
}

/** What's wrong with a row, if anything. */
function problemOf(row: Row, rows: Row[]): string | undefined {
  if (!row.name) return "It needs a name.";
  if (!NAME.test(row.name)) return "Capital letters, digits and _, not starting with a digit.";
  if (rows.some((r) => r !== row && r.name === row.name)) return `${row.name} is here twice.`;
  const flipped = !!row.had && row.had.secret !== row.secret;
  if (!row.value && ((row.secret && !row.had) || (flipped && !row.secret))) {
    return "Type its value.";
  }
  return undefined;
}

/**
 * An app's environment: its own (editable when `editable`) over its
 * space's (shown). Saving changes its own and deploys it again with both.
 */
export function AppEnv(
  { app, where, space, own, editable, open, onClose, call }: {
    app: AppDoc;
    where: string;
    /** The space's environment, and the app's own, once they're read. */
    space?: EnvVar[];
    own?: EnvVar[];
    editable: boolean;
    open: boolean;
    onClose(): void;
    call: Call;
  },
): ReactNode {
  const id = useId();
  const [rows, setRows] = useState<Row[]>();
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // Its own as they're read, until they're changed here.
  const shown = rows ?? own?.map(rowOf);
  const live = app.status === "live";
  const close = () => {
    setRows(undefined);
    setTried(false);
    setError(undefined);
    onClose();
  };
  const set = (key: string, change: Partial<Row>) =>
    setRows((shown ?? []).map((r) => r.key === key ? { ...r, ...change } : r));
  const changes = own && shown ? changesOf(own, shown) : [];
  const problems = (shown ?? []).map((r) => problemOf(r, shown ?? []));
  const save = async () => {
    setTried(true);
    if (!shown || problems.some(Boolean) || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await call("app.configure", { app: app._id, ...(changes.length ? { env: changes } : {}) });
      close();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const ownNames = new Set((shown ?? []).map((r) => r.name));
  return (
    <Dialog
      open={open}
      onClose={close}
      size="lg"
      title={`${app.name}'s environment`}
      description={`What it runs with: ${where}'s environment, and its own over it.`}
      footer={editable
        ? (
          <>
            <span className="app-env-foot">
              {busy && live
                ? "Deploying it again: this takes a minute."
                : live
                ? "Saving deploys it again with them, without a build."
                : "It gets them when it's published."}
            </span>
            <Button onClick={close}>Cancel</Button>
            <Button
              type="submit"
              form={`${id}-form`}
              variant="primary"
              icon={live ? "refresh" : "check"}
              loading={busy}
              disabled={!shown}
            >
              {live ? changes.length ? "Save and deploy" : "Deploy again" : "Save"}
            </Button>
          </>
        )
        : <Button onClick={close}>Close</Button>}
    >
      <form
        id={`${id}-form`}
        className="app-env"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <section className="app-env-section" aria-labelledby={`${id}-own`}>
          <h3 id={`${id}-own`}>Its own</h3>
          {!shown
            ? <Skeleton height={44} radius="lg" />
            : shown.length
            ? (
              <ul className="app-env-rows">
                {shown.map((row, i) => (
                  <OwnRow
                    key={row.key}
                    row={row}
                    editable={editable}
                    problem={tried ? problems[i] : undefined}
                    change={(change) => set(row.key, change)}
                    remove={() => setRows(shown.filter((r) => r.key !== row.key))}
                  />
                ))}
              </ul>
            )
            : (
              <p className="app-env-none">
                None yet: it runs with {where}'s.{editable
                  ? " Add one here to give it something the space doesn't, or another value."
                  : ""}
              </p>
            )}
          {editable && shown
            ? (
              <Button
                size="sm"
                variant="ghost"
                icon="plus"
                className="app-env-add"
                onClick={() =>
                  setRows([...shown, {
                    key: `new-${Date.now()}`,
                    name: "",
                    value: "",
                    secret: false,
                  }])}
              >
                Add a variable
              </Button>
            )
            : null}
        </section>
        <section className="app-env-section" aria-labelledby={`${id}-space`}>
          <h3 id={`${id}-space`}>
            From {where}
            <a className="app-env-link" href={`/space/${encodeURIComponent(app.space)}?tab=env`}>
              Its Environment tab <Icon name="chevron" size={12} />
            </a>
          </h3>
          {!space
            ? <Skeleton height={44} radius="lg" />
            : space.length
            ? (
              <ul className="app-env-inherited">
                {space.map((v) => (
                  <li key={v._id} data-over={ownNames.has(v.name) || undefined}>
                    <code className="app-env-name">{v.name}</code>
                    {v.secret
                      ? (
                        <span className="app-env-sealed">
                          <Icon name="lock" size={12} />
                          {v.hint ?? "secret"}
                        </span>
                      )
                      : <code className="app-env-value" title={v.value}>{v.value || "empty"}</code>}
                    {ownNames.has(v.name)
                      ? <Badge tone="primary" variant="outline">its own over it</Badge>
                      : null}
                  </li>
                ))}
              </ul>
            )
            : <p className="app-env-none">{where} has none yet.</p>}
        </section>
        {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      </form>
    </Dialog>
  );
}

function OwnRow(
  { row, editable, problem, change, remove }: {
    row: Row;
    editable: boolean;
    problem?: string;
    change(change: Partial<Row>): void;
    remove(): void;
  },
): ReactNode {
  const id = useId();
  // A secret's value isn't shown: left empty, it's kept.
  const kept = !!row.had?.secret && row.secret && !row.value;
  if (!editable) {
    return (
      <li className="app-env-row app-env-row-shown">
        <code className="app-env-name">{row.name}</code>
        {row.secret
          ? (
            <span className="app-env-sealed">
              <Icon name="lock" size={12} />
              {row.had?.hint ?? "secret"}
            </span>
          )
          : <code className="app-env-value">{row.value || "empty"}</code>}
      </li>
    );
  }
  return (
    <li className="app-env-row" data-invalid={problem ? true : undefined}>
      <label className="copilotz-sr" htmlFor={`${id}-name`}>Name</label>
      <Input
        id={`${id}-name`}
        size="sm"
        className="app-env-name-input"
        value={row.name}
        placeholder="NAME"
        autoComplete="off"
        spellCheck={false}
        disabled={!!row.had}
        invalid={!!problem && !row.had}
        onChange={(event) => change({ name: typed(event.target.value) })}
      />
      <label className="copilotz-sr" htmlFor={`${id}-value`}>{row.name || "Its"} value</label>
      <Textarea
        id={`${id}-value`}
        className="app-env-value-input"
        value={row.value}
        rows={1}
        autoGrow
        maxHeight={160}
        placeholder={kept
          ? `${row.had?.hint ?? "••••••••"} (kept)`
          : row.secret
          ? "Secret"
          : "Value"}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        invalid={problem === "Type its value."}
        onChange={(event) => change({ value: event.target.value })}
      />
      <Checkbox
        className="app-env-secret"
        checked={row.secret}
        onChange={(event) => change({ secret: event.target.checked })}
        label="Secret"
      />
      <IconButton icon="trash" size="sm" label={`Remove ${row.name || "it"}`} onClick={remove} />
      {problem ? <p className="app-env-problem" role="alert">{problem}</p> : null}
    </li>
  );
}

/** Under a space's environment: its live apps, and giving them the environment as it is now. */
export const appEnvApplyView = (item: EnvChanged, ctx: ViewContext<ReactNode>): ReactNode => {
  const apps = ctx.db.collection("app").query<AppDoc[]>("here", { in: item._id }).value;
  const places = ctx.db.collection("space").query<Place[]>("reached", {}).value;
  if (!apps || !places) return null;
  const live = apps.filter((a) => a.status === "live");
  if (!live.length) return null;
  const manage = places.find((p) => p._id === item._id)?.can?.includes("manage") ?? false;
  const me = ctx.viewer?.name;
  return (
    <>
      <style href="apps-web" precedence="copilotz">{STYLE}</style>
      <ApplyToApps
        live={live}
        theirs={live.filter((a) => manage || a.by === me)}
        {...(item.changed ? { changed: item.changed } : {})}
        call={ctx.call}
      />
    </>
  );
};

function ApplyToApps(
  { live, theirs, changed, call }: {
    live: AppDoc[];
    /** Those the person may give it to: all, when they manage the space; else theirs. */
    theirs: AppDoc[];
    changed?: string;
    call: Call;
  },
): ReactNode {
  const [busy, setBusy] = useState<number>();
  const [applied, setApplied] = useState<string>();
  const [failed, setFailed] = useState<{ name: string; error: string }[]>([]);
  // Changed here since it was last given to them.
  const stale = !!changed && !(applied && applied > changed);
  const apply = async () => {
    const wrong: { name: string; error: string }[] = [];
    for (const [i, app] of theirs.entries()) {
      setBusy(i);
      try {
        await call("app.configure", { app: app._id });
      } catch (e) {
        wrong.push({ name: app.name, error: message(e) });
      }
    }
    setBusy(undefined);
    setFailed(wrong);
    setApplied(new Date().toISOString());
  };
  const names = live.map((a) => a.name);
  return (
    <Card as="section" className="env-apps" data-stale={stale || undefined} aria-label="Its apps">
      <span className="env-apps-icon" aria-hidden="true">
        <Icon name="globe" size={16} />
      </span>
      <div className="env-apps-text">
        <p className="env-apps-title">
          {stale
            ? `${live.length === 1 ? "Its app still runs" : "Its apps still run"} with it as it was`
            : applied && !failed.length
            ? `Given to ${
              listed(theirs.map((a) => a.name))
            }`
            : `${live.length === 1 ? "Its app gets" : `Its ${live.length} apps get`} all of this`}
        </p>
        <p className="env-apps-note">
          {stale
            ? "A change reaches an app when it's published again, or now, deployed again without a build."
            : "Every variable and secret here, computers' or not, with an app's own over them, each time it's published."}
          {" "}
          <span className="env-apps-names">{listed(names)}</span>
        </p>
        {failed.map((f) => (
          <p key={f.name} className="env-apps-failed" role="alert">
            {f.name}: {f.error}
          </p>
        ))}
      </div>
      {theirs.length
        ? (
          <Button
            size="sm"
            variant={stale ? "primary" : "outline"}
            icon="refresh"
            loading={busy !== undefined}
            onClick={apply}
          >
            {busy !== undefined
              ? theirs.length > 1 ? `Deploying ${busy + 1} of ${theirs.length}` : "Deploying"
              : theirs.length === live.length
              ? "Apply to apps"
              : "Apply to yours"}
          </Button>
        )
        : null}
    </Card>
  );
}

/** Names as a sentence lists them: a, b and c. */
const listed = (names: string[]) =>
  names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "";
