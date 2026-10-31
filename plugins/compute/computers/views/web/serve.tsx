/**
 * What jobs serve, on the web: under a job that serves a port, the port and
 * its preview (`computer.preview`: one tap makes it, for the space's
 * members, and opens it in a new tab; or for anyone with the link, or
 * another port it listens on), then, once there's one, opening it and
 * copying its link; and what else it can become (another front end's
 * `jobActions`: published as an app). Over the jobs, the computer's
 * previews in the space, each with who may open it (changing that makes a
 * new link), opening, copying and taking it away (`computer.unpreview`).
 *
 * Each preview says its address (`url`, as `preview.here` gives it).
 */
import { type ReactNode, useState } from "react";
import {
  Button,
  Card,
  CopyButton,
  Icon,
  LazyView,
  Menu,
  type MenuItem,
  message,
  Time,
} from "../../../../../hosts/web/mod.ts";
import type { Preview } from "../../collections/preview.ts";
import type { Job } from "../../shared/workloads.ts";
import type { JobAction, JobServed } from "./kinds.ts";
import { portsOf, previewOfJob, shown, VISIBILITY, type Visibility } from "./previews.ts";
import { whose } from "./names.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** What the jobs' list needs for what they serve: where they run, the previews there, and actions. */
export type Served = {
  call: Call;
  space: string;
  computer: string;
  /** Its desk in the space: previews and apps are made from this one, not the space's default. */
  desk?: string;
  /** The space's folder on the computer, as it shows. */
  folder?: string;
  /** The computer's previews in the space, the newest first. */
  previews: Preview[];
  actions: (JobAction & { key?: string })[];
};

/**
 * A new tab, opened now (while the click still lets it), then sent where
 * the preview is once the app has made it; closed if it fails.
 */
function newTab(): (url?: string) => void {
  const open = typeof globalThis.open === "function" ? globalThis.open.bind(globalThis) : undefined;
  const tab = open?.("about:blank", "_blank") ?? null;
  if (tab) {
    try {
      tab.document.title = "Opening the preview…";
    } catch { /* Not ours to name. */ }
  }
  return (url) => {
    if (!url) return void tab?.close();
    if (!tab) return void open?.(url, "_blank", "noopener");
    tab.opener = null;
    tab.location.href = url;
  };
}

/** Who may open it, said shortly, with its icon. */
function Who({ visibility }: { visibility: Visibility }): ReactNode {
  return (
    <span
      className="serve-who"
      data-visibility={visibility}
      title={VISIBILITY[visibility].hint}
    >
      <Icon name={visibility === "link" ? "globe" : "users"} size={13} />
      {VISIBILITY[visibility].label}
    </span>
  );
}

/** Under a job that serves a port: the port, its preview, and what else it can become. */
export function JobServe(
  { job, title, served }: { job: Job; title: string; served: Served },
): ReactNode {
  const ports = portsOf(job);
  const preview = previewOfJob(served.previews, job.id);
  const url = preview?.url;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const make = async (visibility: Visibility, port?: number) => {
    const open = newTab();
    setBusy(true);
    setError(undefined);
    try {
      const made = await served.call<{ url: string; label: string }>("computer.preview", {
        in: served.space,
        ...(served.desk ? { desk: served.desk } : {}),
        job: job.id,
        ...(port ? { port } : {}),
        visibility,
      });
      open(made.url);
    } catch (e) {
      open();
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const more: (MenuItem | "separator")[] = [
    {
      label: "Preview for space members",
      icon: "users",
      onSelect: () => void make("members"),
    },
    {
      label: "Preview for anyone with the link",
      icon: "globe",
      onSelect: () => void make("link"),
    },
    ...(ports.length > 1
      ? [
        "separator" as const,
        ...ports.map((p): MenuItem => ({
          label: `Preview port ${p}`,
          icon: "eye",
          onSelect: () => void make("members", p),
        })),
      ]
      : []),
  ];
  const item: JobServed = {
    in: served.space,
    computer: served.computer,
    ...(served.desk ? { desk: served.desk } : {}),
    job: job.id,
    name: title,
    command: job.command,
    ...(ports[0] ? { port: ports[0] } : {}),
    ...(job.ports?.length ? { ports: job.ports } : {}),
    ...(served.folder ? { folder: served.folder } : {}),
  };
  return (
    <div className="job-serve">
      <span className="job-serve-what">
        <span className="job-serve-dot" aria-hidden="true" />
        <span>
          Serves {ports.length > 1 ? "ports" : "port"} {ports.map((p, i) => (
            <span key={p}>
              {i ? ", " : ""}
              <code>{p}</code>
            </span>
          ))}
        </span>
        {preview && url
          ? (
            <a className="job-serve-url" href={url} target="_blank" rel="noopener noreferrer">
              {shown(url)}
            </a>
          )
          : null}
      </span>
      <span className="job-serve-actions">
        {preview
          ? (
            <>
              {url ? <CopyButton text={url} label={`Copy the link to ${title}'s preview`} /> : null}
              <Who visibility={preview.visibility} />
              <Button
                size="sm"
                variant="outline"
                icon="external"
                {...(url
                  ? { href: url, target: "_blank", rel: "noopener noreferrer" }
                  : { disabled: true })}
              >
                Open preview
              </Button>
            </>
          )
          : (
            <span className="job-serve-split">
              <Button
                size="sm"
                variant="outline"
                icon="eye"
                loading={busy}
                onClick={() => void make("members")}
              >
                Preview
              </Button>
              <Menu
                label={`More ways to preview ${title}`}
                icon="chevron-down"
                size="sm"
                variant="outline"
                align="end"
                items={more}
              />
            </span>
          )}
        {served.actions.map((a) => (
          <LazyView key={a.key ?? a.view} kind={a.view} item={item} fallback={null} />
        ))}
      </span>
      {error ? <p role="alert" className="jobs-error job-serve-error">{error}</p> : null}
    </div>
  );
}

/** The computer's previews in the space: each with who may open it, opening, copying and taking it away. */
export function Previews(
  { served, jobs, me }: { served: Served; jobs: Job[]; me?: string },
): ReactNode {
  const { previews } = served;
  if (!previews.length) return null;
  return (
    <section className="jobs-group previews" aria-label="Previews">
      <h3>
        Previews
        <span className="jobs-count">{previews.length}</span>
      </h3>
      <ul className="jobs-list">
        {previews.map((p) => (
          <PreviewRow
            key={p._id}
            preview={p}
            {...(p.url ? { url: p.url } : {})}
            job={jobs.find((j) => j.id === p.job)}
            {...(served.desk ? { desk: served.desk } : {})}
            call={served.call}
            me={me}
          />
        ))}
      </ul>
    </section>
  );
}

function PreviewRow(
  { preview: p, url, job, desk, call, me }: {
    preview: Preview;
    url?: string;
    job?: Job;
    /** Its computer's desk in the space, where a new link for it is made. */
    desk?: string;
    call: Call;
    me?: string;
  },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const by = whose(`person:${p.by}`, me);
  const what = job ? (job.name && job.name !== job.id ? job.name : job.command) : undefined;
  const act = async (doing: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await doing();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  // Who may open it is part of its link: another visibility is a new link, and this one goes.
  const change = (visibility: Visibility) =>
    act(async () => {
      await call("computer.preview", {
        in: p.space,
        ...(desk ? { desk } : {}),
        ...(job?.running ? { job: job.id } : {}),
        port: p.port,
        visibility,
      });
      await call("computer.unpreview", { label: p._id });
    });
  const remove = () => act(() => call("computer.unpreview", { label: p._id }));
  const other: Visibility = p.visibility === "link" ? "members" : "link";
  return (
    <Card as="li" padding="none" className="preview" aria-busy={busy || undefined}>
      <div className="preview-row">
        <span className="preview-icon" data-visibility={p.visibility} aria-hidden="true">
          <Icon name="globe" size={15} />
        </span>
        <div className="preview-text">
          {url
            ? (
              <a className="preview-url" href={url} target="_blank" rel="noopener noreferrer">
                {shown(url)}
                <Icon name="external" size={13} />
              </a>
            )
            : <span className="preview-url">{p._id}</span>}
          <p className="preview-meta">
            <span>
              port <code>{p.port}</code>
            </span>
            {what ? <span className="preview-job">{what}</span> : null}
            <span>
              by {by.name} · <Time at={p.at} />
            </span>
          </p>
        </div>
        <div className="preview-actions">
          <Who visibility={p.visibility} />
          {url ? <CopyButton text={url} label="Copy the preview's link" /> : null}
          <Menu
            label={`${shown(url ?? p._id)}: more`}
            size="sm"
            align="end"
            items={[
              {
                label: other === "link"
                  ? "Let anyone with the link open it (new link)"
                  : "Only space members (new link)",
                icon: other === "link" ? "globe" : "users",
                onSelect: () => void change(other),
              },
              "separator",
              {
                label: "Take it away",
                icon: "trash",
                tone: "destructive",
                onSelect: () => void remove(),
              },
            ]}
          />
        </div>
      </div>
      {error ? <p role="alert" className="jobs-error preview-error">{error}</p> : null}
    </Card>
  );
}
