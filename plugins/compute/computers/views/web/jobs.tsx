/**
 * Jobs in a space's folder: commands that keep running (a dev server, a
 * watcher, a long build), everyone's, the agents' too (`jobs.list` with
 * `all`). Each says whose it is, whether it runs or how it ended, and since
 * when; its logs open under it, the end of them, kept current while it
 * runs; and it stops (an agent's, as that agent). One kept running says so.
 * A job that serves a port shows it, with its preview and what else it can
 * become (serve.tsx); the computer's previews come first. A job of your own
 * starts from the top: its command, a name, the port it serves, and whether
 * to keep it running. The list is asked for again every few seconds, more
 * often while it shows, and never while the page is hidden.
 */
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  CodeBlock,
  EmptyState,
  Icon,
  Input,
  message,
  Notice,
  Skeleton,
  Spinner,
  Time,
} from "../../../../../hosts/web/mod.ts";
import type { Job, JobsLogs } from "../../shared/workloads.ts";
import { listOf } from "./calls.ts";
import { type Named, whose, type Work } from "./names.ts";
import { jobToStart, serves } from "./previews.ts";
import { JobServe, Previews, type Served } from "./serve.tsx";

/** How often the list is asked for: while it shows, and while it doesn't. */
const SHOWN_MS = 2_500;
const HIDDEN_MS = 10_000;
/** How often a running job's logs are, and how much of their end. */
const LOGS_MS = 1_500;
const TAIL = 64 * 1024;

export type Jobs = { list?: Job[]; error?: string; refresh(): Promise<void> };

/**
 * The jobs in the folder, kept current while the computer is online; `quiet`
 * (a computer that sleeps, where asking is using it), only while they show.
 */
export function useJobs(work: Work, online: boolean, shown: boolean, quiet = false): Jobs {
  const [list, setList] = useState<Job[]>();
  const [error, setError] = useState<string>();
  // An answer for a folder no longer shown is dropped.
  const current = useRef(work);
  current.current = work;
  const refresh = useCallback(async () => {
    try {
      const got = listOf<Job>(await work("jobs.list", { all: true }), "jobs");
      if (current.current !== work) return;
      setList(got);
      setError(undefined);
    } catch (e) {
      if (current.current === work) setError(message(e));
    }
  }, [work]);
  // Another folder: other jobs.
  useEffect(() => setList(undefined), [work]);
  useEffect(() => {
    if (!online) return;
    void refresh();
    if (quiet && !shown) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, shown ? SHOWN_MS : HIDDEN_MS);
    return () => clearInterval(timer);
  }, [refresh, online, shown, quiet]);
  return { list, error, refresh };
}

const newest = (a: Job, b: Job) =>
  (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt);

export function JobsTab(
  { work, jobs, me, agents, names, active, served }: {
    work: Work;
    jobs: Jobs;
    me?: string;
    /** Agents as they're named, for whose each job is. */
    agents?: Record<string, Named>;
    /** People by name (`namesIn`): whose each is, who started each job. */
    names?: Record<string, string>;
    active: boolean;
    /** Where they run, for what they serve: previews, and what else a server can become. */
    served?: Served;
  },
): ReactNode {
  const [open, setOpen] = useState<string>();
  const list = jobs.list;
  const running = (list ?? []).filter((j) => j.running).sort(newest);
  const ended = (list ?? []).filter((j) => !j.running).sort(newest);
  return (
    <div className="jobs">
      <Start
        work={work}
        started={async (job) => {
          await jobs.refresh();
          setOpen(job.id);
        }}
      />
      {served ? <Previews served={served} jobs={list ?? []} me={me} names={names} /> : null}
      {jobs.error && list === undefined
        ? (
          <Notice tone="destructive" role="alert" title="Couldn't list the jobs">
            {jobs.error}
          </Notice>
        )
        : null}
      {list === undefined
        ? (
          jobs.error ? null : (
            <div className="jobs-list" aria-busy="true">
              {[0, 1].map((i) => <Skeleton key={i} height={58} radius="xl" />)}
            </div>
          )
        )
        : list.length
        ? (
          <>
            {[["Running", running], ["Ended", ended]].map(([title, group]) =>
              (group as Job[]).length
                ? (
                  <section
                    key={title as string}
                    className="jobs-group"
                    aria-label={title as string}
                  >
                    <h3>
                      {title as string}
                      <span className="jobs-count">{(group as Job[]).length}</span>
                    </h3>
                    <ul className="jobs-list">
                      {(group as Job[]).map((job) => (
                        <JobRow
                          key={job.id}
                          job={job}
                          me={me}
                          agents={agents}
                          names={names}
                          work={work}
                          open={open === job.id}
                          toggle={() => setOpen(open === job.id ? undefined : job.id)}
                          stopped={jobs.refresh}
                          active={active}
                          {...(served ? { served } : {})}
                        />
                      ))}
                    </ul>
                  </section>
                )
                : null
            )}
          </>
        )
        : (
          <EmptyState icon="activity" title="No jobs here yet" className="jobs-empty">
            Jobs are commands that keep running: a dev server, a watcher, a long build. Start one
            above, or ask an agent to; theirs show here too. A job that serves a port gets a
            preview: an address to open what it serves.
          </EmptyState>
        )}
    </div>
  );
}

/**
 * Starting a job of your own: its command, a name if you like, the port it
 * serves (for its preview), and whether to keep it running (started again
 * whenever the computer starts: a cloud computer's wake, say).
 */
function Start({ work, started }: { work: Work; started(job: Job): Promise<void> }): ReactNode {
  const [command, setCommand] = useState("");
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const id = useId();
  return (
    <form
      className="jobs-start"
      aria-label="Start a job"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!command.trim() || busy) return;
        const input = jobToStart({ command, name, port, keep });
        if ("error" in input) return setError(input.error);
        setBusy(true);
        setError(undefined);
        try {
          const job = await work<Job>("jobs.start", input);
          setCommand("");
          setName("");
          setPort("");
          setKeep(false);
          await started(job);
        } catch (e) {
          setError(message(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="copilotz-sr" htmlFor={`${id}-command`}>The job's command</label>
      <Input
        id={`${id}-command`}
        icon="terminal"
        className="jobs-command"
        value={command}
        placeholder="npm run dev"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        invalid={!!error}
        onChange={(event) => setCommand(event.target.value)}
      />
      <label className="copilotz-sr" htmlFor={`${id}-name`}>Its name (if you like)</label>
      <Input
        id={`${id}-name`}
        className="jobs-name"
        value={name}
        placeholder="Name (optional)"
        autoComplete="off"
        onChange={(event) => setName(event.target.value)}
      />
      <label className="copilotz-sr" htmlFor={`${id}-port`}>
        The port it serves (if it's a server)
      </label>
      <Input
        id={`${id}-port`}
        className="jobs-port"
        value={port}
        placeholder="Port"
        inputMode="numeric"
        autoComplete="off"
        title="The port it serves, if it's a server: for its preview"
        onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))}
      />
      <Button type="submit" variant="primary" icon="play" loading={busy} disabled={!command.trim()}>
        Start
      </Button>
      <Checkbox
        className="jobs-keep"
        checked={keep}
        onChange={(event) => setKeep(event.target.checked)}
        label={
          <>
            Keep running{" "}
            <span className="jobs-keep-hint">
              · started again whenever the computer starts
            </span>
          </>
        }
      />
      {error ? <p role="alert" className="jobs-error">{error}</p> : null}
    </form>
  );
}

function JobRow(
  { job, me, agents, names, work, open, toggle, stopped, active, served }: {
    job: Job;
    me?: string;
    agents?: Record<string, Named>;
    names?: Record<string, string>;
    work: Work;
    open: boolean;
    toggle(): void;
    stopped(): Promise<void>;
    active: boolean;
    served?: Served;
  },
): ReactNode {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string>();
  const who = whose(job.who, me, agents, names);
  const failed = !job.running && job.exitCode !== 0;
  // Without a name of its own, a job goes by its command.
  const title = job.name && job.name !== job.id ? job.name : job.command;
  const id = useId();
  return (
    <Card as="li" padding="none" className="job" data-open={open || undefined}>
      <div className="job-row">
        <span
          className="job-state"
          data-state={job.running ? "running" : failed ? "failed" : "done"}
          aria-hidden="true"
        >
          {job.running
            ? <span className="job-pulse" />
            : <Icon name={failed ? "close" : "check"} size={14} />}
        </span>
        <div className="job-text">
          <p className="job-name">
            <span className="job-title">{title}</span>
            {job.running
              ? <Badge tone="success">running</Badge>
              : failed
              ? <Badge tone="destructive">exit {job.exitCode}</Badge>
              : <Badge>done</Badge>}
            {job.keep
              ? (
                <Badge
                  tone="primary"
                  variant="outline"
                  title="Kept running: started again whenever the computer starts"
                >
                  kept
                </Badge>
              )
              : null}
          </p>
          {title !== job.command ? <code className="job-command">{job.command}</code> : null}
          <p className="job-meta">
            <span className="job-who">
              <Avatar
                name={who.mine ? me ?? who.name : who.name}
                kind={who.agent ? "agent" : "person"}
                icon={who.icon}
                size={16}
              />
              {who.name}
            </span>
            <span aria-hidden="true">·</span>
            {job.running
              ? (
                <span>
                  started <Time at={job.startedAt} long />
                </span>
              )
              : (
                <span>
                  ended <Time at={job.endedAt ?? job.startedAt} long />
                </span>
              )}
          </p>
        </div>
        <div className="job-actions">
          <Button
            size="sm"
            variant="ghost"
            iconEnd={open ? "chevron-down" : "chevron"}
            aria-expanded={open}
            aria-controls={`${id}-logs`}
            onClick={toggle}
          >
            Logs
          </Button>
          {job.running
            ? (
              <Button
                size="sm"
                icon="stop"
                loading={stopping}
                onClick={async () => {
                  setStopping(true);
                  setError(undefined);
                  try {
                    await work("jobs.stop", { id: job.id }, job.who);
                    await stopped();
                  } catch (e) {
                    setError(message(e));
                  } finally {
                    setStopping(false);
                  }
                }}
              >
                Stop
              </Button>
            )
            : null}
        </div>
      </div>
      {error ? <p role="alert" className="jobs-error job-error">{error}</p> : null}
      {served && serves(job) ? <JobServe job={job} title={title} served={served} /> : null}
      {open
        ? (
          <div id={`${id}-logs`} className="job-logs">
            <Logs job={job} title={title} work={work} active={active} />
          </div>
        )
        : null}
    </Card>
  );
}

/** A job's logs: the end of what it wrote, kept current while it runs. */
function Logs(
  { job, title, work, active }: { job: Job; title: string; work: Work; active: boolean },
): ReactNode {
  const [logs, setLogs] = useState<JobsLogs>();
  const [error, setError] = useState<string>();
  const running = useRef(job.running);
  running.current = job.running;
  useEffect(() => {
    let stop = false;
    const read = async () => {
      try {
        const got = await work<JobsLogs>("jobs.logs", { id: job.id, tail: TAIL }, job.who);
        if (!stop) {
          setLogs(got);
          setError(undefined);
        }
      } catch (e) {
        if (!stop) setError(message(e));
      }
    };
    void read();
    if (!active) return () => void (stop = true);
    const timer = setInterval(() => {
      if (running.current && document.visibilityState === "visible") void read();
    }, LOGS_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [job.id, job.running, active]);
  if (error && !logs) return <Notice tone="destructive" role="alert">{error}</Notice>;
  if (!logs) {
    return (
      <p className="job-loading" role="status">
        <Spinner size={14} /> Reading its logs…
      </p>
    );
  }
  return (
    <div className="job-streams">
      <CodeBlock
        title="Output"
        code={logs.stdout}
        empty={job.running ? "Nothing yet" : "It wrote nothing"}
        height={16}
        follow
        copy
        label={`What ${title} wrote`}
        footer={logs.truncated ? "Only the end of it is kept." : undefined}
      />
      {logs.stderr
        ? (
          <CodeBlock
            title="Errors"
            code={[{ text: logs.stderr, tone: "error" }]}
            height={10}
            follow
            copy
            label={`What ${title} wrote as errors`}
          />
        )
        : null}
    </div>
  );
}
