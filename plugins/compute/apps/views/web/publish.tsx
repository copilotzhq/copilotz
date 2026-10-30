/**
 * Publishing a job as an app (kind `app.publish`: computers' `jobActions`
 * View, drawn under a job that serves a port; item: computers' `JobServed`).
 * In the job's row: "Publish", or, once it's published, how that's going
 * (Building…, Published, Publish failed). Its dialog asks for a name (the
 * address it makes, `https://<label>.copilotz.app`, shown as it's typed),
 * the folder (the space's, or one inside it) and the port; publishing
 * (`app.publish`) then shows the app as it builds, live (the space's apps,
 * `app.here`, observed): Building…, then its address, or what went wrong,
 * with Try again (`app.redeploy`).
 */
import { type ReactNode, useEffect, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Button,
  CodeBlock,
  CopyButton,
  Dialog,
  Field,
  Icon,
  Input,
  message,
  Notice,
  Spinner,
} from "../../../../../hosts/web/mod.ts";
import type { AppDoc } from "../../collections/app.ts";
import {
  addressFor,
  appOfJob,
  domainOf,
  folderOf,
  type JobServed,
  lookOf,
  shown,
  suggestedName,
} from "./apps.ts";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export const appPublishView = (item: JobServed, ctx: ViewContext<ReactNode>): ReactNode => {
  const apps = ctx.db.collection("app").query<AppDoc[]>("here", { in: item.in }).value;
  if (!apps || !item.job) return null;
  return (
    <>
      <style href="apps-web" precedence="copilotz">{STYLE}</style>
      <Publish item={item} apps={apps} call={ctx.call} />
    </>
  );
};

function Publish(
  { item, apps, call }: { item: JobServed; apps: AppDoc[]; call: Call },
): ReactNode {
  const [open, setOpen] = useState(false);
  // The app this dialog published, and whether it shows the form (else the app as it goes).
  const [published, setPublished] = useState<string>();
  const [form, setForm] = useState(true);
  const app = apps.find((a) => a._id === published) ?? appOfJob(apps, item.job, item.computer);
  const look = app ? lookOf(app) : undefined;
  const show = () => {
    setForm(!app);
    setOpen(true);
  };
  return (
    <>
      {app && look
        ? (
          <Button
            size="sm"
            variant="ghost"
            className="publish-trigger"
            data-status={app.status}
            title={`${app.name}: ${look.label.toLowerCase()}`}
            onClick={show}
          >
            {look.busy
              ? <Spinner size={13} />
              : <Icon name={app.status === "live" ? "check-circle" : "alert"} size={14} />}
            {app.status === "building"
              ? "Building…"
              : app.status === "live"
              ? "Published"
              : "Publish failed"}
          </Button>
        )
        : (
          <Button size="sm" variant="outline" icon="share" onClick={show}>
            Publish
          </Button>
        )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={form || !app ? "Publish as an app" : app.name}
        description={form || !app
          ? "It's built from its folder and runs on its own, without this computer, at an " +
            "address anyone can open."
          : undefined}
        footer={form || !app ? undefined : (
          <>
            <Button onClick={() => setOpen(false)}>Close</Button>
            {app.status === "live"
              ? (
                <Button
                  variant="primary"
                  icon="external"
                  href={app.url}
                  target="_blank"
                  rel="noopener"
                >
                  Open {shown(app.url)}
                </Button>
              )
              : null}
          </>
        )}
      >
        {form || !app
          ? (
            <PublishForm
              key={app?._id ?? "new"}
              item={item}
              apps={apps}
              call={call}
              cancel={() => setOpen(false)}
              {...(app ? { from: app } : {})}
              published={(id) => {
                setPublished(id);
                setForm(false);
              }}
            />
          )
          : <AppStatus app={app} call={call} again={() => setForm(true)} />}
      </Dialog>
    </>
  );
}

/** The name (and the address it makes), the folder and the port; then `app.publish`. */
function PublishForm(
  { item, apps, call, cancel, published, from }: {
    item: JobServed;
    apps: AppDoc[];
    call: Call;
    cancel(): void;
    published(app: string): void;
    /** The app it was published as, whose name and folder it starts from. */
    from?: AppDoc;
  },
): ReactNode {
  const [name, setName] = useState(() => from?.name ?? suggestedName(item, item.folder));
  const [folder, setFolder] = useState(from?.source.path ?? "");
  const [port, setPort] = useState(item.port ? String(item.port) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const domain = domainOf(apps);
  const address = addressFor(name, domain);
  const already = apps.find((a) => a.name === name.trim());
  const where = folderOf(folder);
  const number = Number(port);
  const portBad = !!port && !(Number.isInteger(number) && number >= 1 && number <= 65535);
  return (
    <form
      className="publish-form"
      aria-label="Publish as an app"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || !name.trim() || "error" in where || portBad) return;
        setBusy(true);
        setError(undefined);
        try {
          const answer = await call<{ app: string }>("app.publish", {
            in: item.in,
            name: name.trim(),
            job: item.job,
            ...(port ? { port: number } : {}),
            ...(where.path ? { path: where.path } : {}),
          });
          published(answer.app);
        } catch (e) {
          setError(message(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field
        label="Name"
        hint={already
          ? `${already.name} is published already: this publishes a new version of it.`
          : undefined}
      >
        {(control) => (
          <Input
            {...control}
            value={name}
            maxLength={80}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </Field>
      <p className="publish-address" aria-live="polite">
        <Icon name="globe" size={15} />
        {already ? <code>{shown(already.url)}</code> : address
          ? (
            <span>
              <code>{shown(address)}</code>
              <span className="publish-address-note">
                {" "}· or with a short suffix, if it's taken
              </span>
            </span>
          )
          : <span className="publish-address-note">Its address comes from its name.</span>}
      </p>
      <div className="publish-row">
        <Field
          label="Folder"
          hint="The space's folder, or a folder inside it: what's built."
          error={"error" in where ? where.error : undefined}
          className="publish-folder"
        >
          {(control) => (
            <div className="publish-folder-box">
              {item.folder
                ? (
                  <span className="publish-folder-base" title={item.folder}>
                    {baseOf(item.folder)}/
                  </span>
                )
                : null}
              <Input
                {...control}
                value={folder}
                placeholder="all of it"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => setFolder(event.target.value)}
              />
            </div>
          )}
        </Field>
        <Field
          label="Port"
          hint={item.port ? "The job's" : "What it serves"}
          error={portBad ? "From 1 to 65535" : undefined}
          className="publish-port"
        >
          {(control) => (
            <Input
              {...control}
              value={port}
              inputMode="numeric"
              autoComplete="off"
              onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))}
            />
          )}
        </Field>
      </div>
      <p className="publish-how">
        <Icon name="info" size={15} />
        <span>
          Its Dockerfile builds it, or, without one, it's detected and run with{" "}
          <code>{item.command}</code>. It scales to nothing when nobody uses it. Building takes a
          few minutes.
        </span>
      </p>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      <div className="publish-go">
        <Button onClick={cancel}>Cancel</Button>
        <Button
          type="submit"
          variant="primary"
          icon="share"
          loading={busy}
          disabled={!name.trim() || "error" in where || portBad}
        >
          {already ? "Publish again" : "Publish"}
        </Button>
      </div>
    </form>
  );
}

/** A folder as its prefix shows it: its own name, after an ellipsis when it's deeper. */
const baseOf = (folder: string) => {
  const parts = folder.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? `…/${parts.at(-1)}` : folder;
};

/** Seconds since `since`, every second while `on`. */
function useElapsed(on: boolean): number {
  const [since] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return Math.max(0, Math.floor((now - since) / 1000));
}

/** An app as it goes, live: building, then live at its address, or failed, saying why. */
export function AppStatus(
  { app, call, again }: { app: AppDoc; call: Call; again?(): void },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const building = app.status === "building";
  const elapsed = useElapsed(building);
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
  return (
    <div className="app-status" data-status={app.status} role="status" aria-live="polite">
      <span className="app-status-icon" aria-hidden="true">
        {building
          ? <Spinner size={22} />
          : <Icon name={app.status === "live" ? "check" : "alert"} size={22} />}
      </span>
      <div className="app-status-text">
        <p className="app-status-title">
          {building
            ? `Building ${app.name}…`
            : app.status === "live"
            ? `${app.name} is live`
            : `Couldn't publish ${app.name}`}
        </p>
        {building
          ? (
            <>
              <p>
                Packing its folder, building it, and starting it. This usually takes a few minutes:
                you can close this, and the space's Apps tab shows how it goes.
              </p>
              <div className="app-building" aria-hidden="true">
                <span />
              </div>
              <p className="app-status-meta">
                {elapsed >= 60
                  ? `${Math.floor(elapsed / 60)} min ${elapsed % 60} s`
                  : `${elapsed} s`} · at <code>{shown(app.url)}</code> once it's live
              </p>
            </>
          )
          : app.status === "live"
          ? (
            <p className="app-status-url">
              <a href={app.url} target="_blank" rel="noopener">{shown(app.url)}</a>
              <CopyButton text={app.url} label={`Copy ${app.name}'s address`} />
            </p>
          )
          : null}
        {app.error && !building
          ? (
            <>
              {app.status === "live"
                ? (
                  <Notice tone="warning" title="Its last publish failed">
                    The version before it is still live.
                  </Notice>
                )
                : null}
              <CodeBlock
                className="app-status-error"
                code={[{ text: app.error, tone: "error" }]}
                lines={8}
                copy
                label={`Why ${app.name} didn't publish`}
              />
            </>
          )
          : null}
        {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
        {!building
          ? (
            <div className="app-status-actions">
              {app.status === "failed" || app.error
                ? (
                  <Button
                    size="sm"
                    variant="primary"
                    icon="retry"
                    loading={busy}
                    onClick={redeploy}
                  >
                    Try again
                  </Button>
                )
                : (
                  <Button size="sm" icon="refresh" loading={busy} onClick={redeploy}>
                    Publish again
                  </Button>
                )}
              {again
                ? (
                  <Button size="sm" variant="ghost" onClick={again}>
                    Publish with other settings…
                  </Button>
                )
                : null}
            </div>
          )
          : null}
      </div>
    </div>
  );
}
