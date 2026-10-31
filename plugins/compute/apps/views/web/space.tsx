/**
 * A space's apps (kind `app.space`: its Apps tab, spaces' `spaceTabs`; item
 * `{ _id }`, the space): what was published from its computers, live
 * (`app.here`): each app's address (open it, copy it), whether it's live,
 * building or failed (and why, with Try again), what it's built from, who
 * published it and when; publishing it again (`app.redeploy`), its
 * environment (env.tsx: its own over the space's, `envVar`'s `apps` and
 * `here`), and taking it down (`app.remove`, asked first: its publisher or
 * the space's managers). With none yet, how to publish one. In a side
 * panel, the same, compact.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  Dialog,
  EmptyState,
  Icon,
  Menu,
  type MenuItem,
  message,
  Notice,
  Skeleton,
  Spinner,
  Time,
} from "../../../../../hosts/web/mod.ts";
import type { EnvVar } from "../../../computers/contract.ts";
import type { AppDoc } from "../../collections/app.ts";
import { lookOf, shown } from "./apps.ts";
import { AppEnv } from "./env.tsx";
import { AppStatus } from "./publish.tsx";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;
type Place = { _id: string; name: string; kind: string; can?: string[] };
type Machine = { computer: string; name?: string; folder?: string };

export const appsSpaceView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const space = item._id ?? (typeof ctx.hints.in === "string" ? ctx.hints.in : "");
  const apps = ctx.db.collection("app").query<AppDoc[]>("here", { in: space }).value;
  const places = ctx.db.collection("space").query<Place[]>("reached", {}).value;
  // Its computers, as they're named: what each app is built from.
  const desks = ctx.db.collection("desk").query<Machine[]>("here", { in: space }).value;
  // The space's environment, and each app's own over it.
  const env = ctx.db.collection("envVar").query<EnvVar[]>("here", { in: space }).value;
  const owns = ctx.db.collection("envVar").query<EnvVar[]>("apps", { in: space }).value;
  const compact = ctx.hints.mode === "panel";
  const style = <style href="apps-web" precedence="copilotz">{STYLE}</style>;
  if (!apps || !places) {
    return (
      <div className="apps" aria-busy="true">
        {style}
        {[0, 1].map((i) => <Skeleton key={i} height={compact ? 64 : 84} radius="xl" />)}
      </div>
    );
  }
  const place = places.find((p) => p._id === space);
  return (
    <>
      {style}
      <Apps
        space={space}
        where={place ? place.kind === "personal" ? "Personal" : place.name : "this space"}
        can={place?.can ?? []}
        apps={apps}
        machines={desks ?? []}
        {...(env ? { env } : {})}
        {...(owns ? { owns } : {})}
        me={ctx.viewer?.name}
        compact={compact}
        call={ctx.call}
      />
    </>
  );
};

function Apps(
  { space, where, can, apps, machines, env, owns, me, compact, call }: {
    space: string;
    where: string;
    can: string[];
    apps: AppDoc[];
    machines: Machine[];
    /** The space's environment, and its apps' own, once they're read. */
    env?: EnvVar[];
    owns?: EnvVar[];
    me?: string;
    compact: boolean;
    call: Call;
  },
): ReactNode {
  const [removing, setRemoving] = useState<AppDoc>();
  if (!apps.length) {
    return (
      <div className={`apps${compact ? " apps-compact" : ""}`}>
        <EmptyState
          icon="globe"
          tone="primary"
          title="No apps yet"
          className="apps-empty"
          action={
            <Button
              variant="primary"
              icon="computer"
              href={`/space/${encodeURIComponent(space)}?tab=computer`}
            >
              Go to its computer
            </Button>
          }
        >
          An app is what a job serves, published: built from its folder, it runs on its own at an
          address like{" "}
          <code>shop.copilotz.app</code>, without the computer. Publish one from a job that serves a
          port, under the Computer tab's Jobs, or ask an agent to.
        </EmptyState>
      </div>
    );
  }
  const live = apps.filter((a) => a.status === "live").length;
  return (
    <div className={`apps${compact ? " apps-compact" : ""}`}>
      {compact ? null : (
        <p className="apps-intro">
          {apps.length === 1 ? "One app" : `${apps.length} apps`} published from {where}
          {live && live < apps.length ? `, ${live} live` : ""}. They run on their own, without its
          computer.
        </p>
      )}
      <ul className="apps-list" aria-label={`${where}'s apps`}>
        {apps.map((app) => (
          <AppRow
            key={app._id}
            app={app}
            machine={machines.find((m) => m.computer === app.source.computer)}
            where={where}
            {...(env ? { env } : {})}
            {...(owns ? { own: owns.filter((v) => v.app === app._id) } : {})}
            me={me}
            write={can.includes("write")}
            manage={can.includes("manage")}
            remove={() => setRemoving(app)}
            call={call}
          />
        ))}
      </ul>
      <Remove app={removing} onClose={() => setRemoving(undefined)} call={call} />
    </div>
  );
}

function AppRow(
  { app, machine, where, env, own, me, write, manage, remove, call }: {
    app: AppDoc;
    machine?: Machine;
    where: string;
    env?: EnvVar[];
    own?: EnvVar[];
    me?: string;
    write: boolean;
    manage: boolean;
    remove(): void;
    call: Call;
  },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [details, setDetails] = useState(false);
  const [environment, setEnvironment] = useState(false);
  const look = lookOf(app);
  const redeploy = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await call("app.redeploy", { app: app._id });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const items: (MenuItem | "separator")[] = [
    ...(write && app.status !== "building"
      ? [{ label: "Publish again", icon: "refresh" as const, onSelect: () => void redeploy() }]
      : []),
    { label: "Environment", icon: "lock" as const, onSelect: () => setEnvironment(true) },
    ...(app.error
      ? [{ label: "Why it failed", icon: "info" as const, onSelect: () => setDetails(true) }]
      : []),
    ...(app.by === me || manage
      ? [
        "separator" as const,
        {
          label: "Take it down",
          icon: "trash" as const,
          tone: "destructive" as const,
          onSelect: remove,
        },
      ]
      : []),
  ];
  const from = [
    app.source.path ? `the folder ${app.source.path}` : "its folder",
    machine?.name ? `on ${machine.name}` : undefined,
  ].filter(Boolean).join(" ");
  return (
    <Card as="li" padding="none" className="app" data-status={app.status}>
      <div className="app-row">
        <span className="app-icon" aria-hidden="true">
          {look.busy ? <Spinner size={16} /> : <Icon name="globe" size={17} />}
        </span>
        <div className="app-text">
          <p className="app-name">
            <span className="app-title">{app.name}</span>
            <Badge tone={look.tone}>{look.busy ? `${look.label}…` : look.label}</Badge>
          </p>
          <p className="app-url">
            {app.status === "live"
              ? (
                <a href={app.url} target="_blank" rel="noopener">
                  {shown(app.url)}
                  <Icon name="external" size={12} />
                </a>
              )
              : <span>{shown(app.url)}</span>}
            <CopyButton text={app.url} label={`Copy ${app.name}'s address`} />
          </p>
          <p className="app-meta">
            <span>
              From {from} · port <code>{app.source.port}</code>
            </span>
            <span>
              {app.by === me ? "by you" : `by ${app.by}`} · <Time at={app.live ?? app.at} />
            </span>
            {own?.length
              ? (
                <button
                  type="button"
                  className="app-env-count"
                  onClick={() => setEnvironment(true)}
                >
                  <Icon name="lock" size={11} />
                  {own.length === 1
                    ? "1 variable of its own"
                    : `${own.length} variables of its own`}
                </button>
              )
              : null}
          </p>
        </div>
        <div className="app-actions">
          {app.status === "live"
            ? (
              <Button size="sm" icon="external" href={app.url} target="_blank" rel="noopener">
                Open
              </Button>
            )
            : app.status === "failed" && write
            ? (
              <Button size="sm" variant="primary" icon="retry" loading={busy} onClick={redeploy}>
                Try again
              </Button>
            )
            : null}
          {items.length
            ? <Menu label={`${app.name}: more`} items={items} align="end" size="sm" />
            : null}
        </div>
      </div>
      {app.status === "building"
        ? (
          <div className="app-building" role="status" aria-label={`Building ${app.name}`}>
            <span />
          </div>
        )
        : null}
      {app.error && app.status !== "building"
        ? (
          <div className="app-problem">
            <Notice
              tone={app.status === "live" ? "warning" : "destructive"}
              action={
                <Button size="sm" variant="ghost" onClick={() => setDetails(true)}>Details</Button>
              }
            >
              {app.status === "live"
                ? "Its last publish failed; the version before is still live."
                : firstLine(app.error)}
            </Notice>
          </div>
        )
        : null}
      {error ? <p role="alert" className="app-error">{error}</p> : null}
      <Dialog
        open={details}
        onClose={() => setDetails(false)}
        title={app.name}
        size="lg"
        footer={<Button onClick={() => setDetails(false)}>Close</Button>}
      >
        <AppStatus app={app} call={call} />
      </Dialog>
      <AppEnv
        app={app}
        where={where}
        {...(env ? { space: env } : {})}
        {...(own ? { own } : {})}
        editable={app.by === me || manage}
        open={environment}
        onClose={() => setEnvironment(false)}
        call={call}
      />
    </Card>
  );
}

/** An error's first line, short, as a row says it. */
const firstLine = (error: string) => {
  const line = error.split("\n").find((l) => l.trim())?.trim() ?? error;
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
};

/** Taking an app down, once they've said so: its address stops working. */
function Remove(
  { app, onClose, call }: { app?: AppDoc; onClose(): void; call: Call },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const close = () => {
    setError(undefined);
    onClose();
  };
  return (
    <Dialog
      open={!!app}
      onClose={close}
      size="sm"
      title={app ? `Take ${app.name} down?` : ""}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="destructive"
            icon="trash"
            loading={busy}
            onClick={async () => {
              if (!app) return;
              setBusy(true);
              try {
                await call("app.remove", { app: app._id });
                close();
              } catch (e) {
                setError(message(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Take it down
          </Button>
        </>
      }
    >
      <p className="apps-dialog-text">
        Its address{app
          ? (
            <>
              , <code>{shown(app.url)}</code>,
            </>
          )
          : null}{" "}
        stops working. Its folder stays on the computer, and you can publish it again from its job.
      </p>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
    </Dialog>
  );
}
