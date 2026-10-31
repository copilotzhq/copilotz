/**
 * An agent's call to a computer tool, in the conversation (kind
 * `computer.step`, for chat's `toolViews`), as people read it rather than
 * as data: a command and what it printed, how it ended; a job started,
 * listed, read or stopped; a folder's files; a file read, written (its
 * text, as added lines) or edited (what changed, line by line); search
 * results as links; the browser's steps and where it ended up. While the
 * call runs, it says so; one that waits on your OK, or found no computer,
 * or failed, says that instead.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Badge,
  bytes,
  CodeBlock,
  type CodePart,
  Icon,
  type IconName,
  safeHref,
  Spinner,
} from "../../../../../hosts/web/mod.ts";
import type { ShownCall } from "../../../../agents/chat/contract.ts";
import type { Entry, Job, JobsLogs, SearchResult } from "../../shared/workloads.ts";
import { listOf, type Outcome, outcome, terminalCall, took } from "./calls.ts";
import { lineDiff } from "./diff.ts";
import { STYLE } from "./style.ts";

const str = (value: unknown) => typeof value === "string" ? value : "";

/** What a call's state says at the end of its line: running, waiting, missing, failed. */
function Status({ done }: { done: Outcome }): ReactNode {
  if (done.kind === "running") {
    return (
      <span className="step-status">
        <Spinner size={12} /> running
      </span>
    );
  }
  if (done.kind === "waiting") return <Badge tone="warning">asked you first</Badge>;
  if (done.kind === "missing") return <Badge>no computer</Badge>;
  if (done.kind === "failed") return <Badge tone="destructive">failed</Badge>;
  return null;
}

/** What went wrong, or why it didn't run, under the call's line. */
const why = (done: Outcome): CodePart[] | undefined =>
  done.kind === "failed"
    ? [{ text: done.text, tone: "error" }]
    : done.kind === "missing"
    ? [{ text: done.text, tone: "muted" }]
    : done.kind === "waiting"
    ? [{ text: "It asked for your OK before doing it.", tone: "muted" }]
    : undefined;

/** What a call returned that its View doesn't know: its words, as they are. */
const said = (done: Outcome): CodePart[] =>
  done.kind === "done" && done.value !== undefined && done.value !== null
    ? [{
      text: typeof done.value === "string" ? done.value : JSON.stringify(done.value, null, 2),
      tone: "muted",
    }]
    : [];

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A line with an icon and a few words, when there's nothing more to show. */
function Line(
  { icon, children, status }: { icon: IconName; children: ReactNode; status?: ReactNode },
): ReactNode {
  return (
    <p className="step-line">
      <Icon name={icon} size={14} />
      <span className="step-line-text">{children}</span>
      {status}
    </p>
  );
}

function Terminal({ call, done }: { call: ShownCall; done: Outcome }): ReactNode {
  const { mode, text, result } = terminalCall(call);
  const out: CodePart[] = result
    ? [
      ...(result.stdout ? [{ text: result.stdout }] : []),
      ...(result.stderr ? [{ text: result.stderr, tone: "error" as const }] : []),
    ]
    : why(done) ?? said(done);
  const title = mode === "run"
    ? (
      <code className="step-command">
        <span className="step-prompt">$</span>
        {text}
      </code>
    )
    : mode === "input"
    ? (
      <span>
        Typed <code>{text}</code> into the command
      </span>
    )
    : mode === "interrupt"
    ? <span>Stopped the command (Ctrl+C)</span>
    : <span>Looked at the command running</span>;
  const ended = result && result.state === "idle" && result.exitCode !== null;
  return (
    <CodeBlock
      className="step-block"
      title={title}
      actions={<Status done={done} />}
      code={out}
      lines={10}
      from="end"
      empty={done.kind === "running" ? undefined : result ? "No output" : undefined}
      footer={result
        ? (
          <>
            {result.state === "running" ? <span>still running</span> : ended
              ? (
                result.exitCode === 0
                  ? (
                    <span className="step-ok">
                      <Icon name="check" size={13} /> exit 0
                    </span>
                  )
                  : <span className="step-bad">exit {result.exitCode}</span>
              )
              : null}
            {result.interrupted ? <span>stopped</span> : null}
            {result.timedOut ? <span className="step-bad">timed out</span> : null}
            {result.stdoutTruncated || result.stderrTruncated
              ? <span>some output left out</span>
              : null}
            <span>{took(result.durationMs)}</span>
            {result.cwd && result.cwd !== "." ? <code>{result.cwd}</code> : null}
          </>
        )
        : undefined}
      label={mode === "run" ? `The command ${text}` : "The command"}
    />
  );
}

function StartJob({ call, done }: { call: ShownCall; done: Outcome }): ReactNode {
  const job = done.kind === "done" && record(done.value) && "id" in done.value
    ? done.value as Partial<Job>
    : undefined;
  const command = str(call.input?.command);
  const named = job?.name && job.name !== command && job.name !== job.id;
  return (
    <CodeBlock
      className="step-block"
      title={
        <code className="step-command">
          <span className="step-prompt">$</span>
          {command}
        </code>
      }
      actions={job ? <Badge tone="success">job started</Badge> : <Status done={done} />}
      code={why(done) ??
        (job
          ? [{ text: `Running in the background${named ? ` as ${job.name}` : ""}`, tone: "muted" }]
          : said(done))}
      label={`The job ${command}`}
    />
  );
}

function Logs({ call, done }: { call: ShownCall; done: Outcome }): ReactNode {
  const logs = done.kind === "done" ? done.value as Partial<JobsLogs> : undefined;
  const name = logs?.job?.name ?? str(call.input?.id);
  return (
    <CodeBlock
      className="step-block"
      title={
        <span>
          Read the logs of <b>{name}</b>
        </span>
      }
      actions={logs?.job
        ? (
          <Badge tone={logs.job.running ? "success" : "neutral"}>
            {logs.job.running ? "running" : `exit ${logs.job.exitCode}`}
          </Badge>
        )
        : <Status done={done} />}
      code={why(done) ??
        [
          ...(logs?.stdout ? [{ text: logs.stdout }] : []),
          ...(logs?.stderr ? [{ text: logs.stderr, tone: "error" as const }] : []),
        ]}
      lines={8}
      from="end"
      empty="Nothing written yet"
      label={`The logs of ${name}`}
    />
  );
}

function Jobs({ call, done }: { call: ShownCall; done: Outcome }): ReactNode {
  if (done.kind !== "done") {
    return <Line icon="activity" status={<Status done={done} />}>Listing its jobs</Line>;
  }
  const jobs = listOf<Job>(done.value, "jobs");
  if (call.name === "stop_job") {
    const job = done.value as Partial<Job>;
    return (
      <Line icon="stop">
        Stopped <b>{job.name ?? str(call.input?.id)}</b>
        {job.exitCode !== undefined && job.exitCode !== null ? <>(exit {job.exitCode})</> : null}
      </Line>
    );
  }
  return (
    <CodeBlock
      className="step-block"
      title={<span>Its jobs here</span>}
      code={jobs.map((j) => [
        { text: j.running ? "● " : "○ ", tone: j.running ? "accent" as const : "muted" as const },
        { text: `${j.name}` },
        {
          text: `  ${j.command !== j.name ? `${j.command} · ` : ""}${
            j.running ? "running" : `exit ${j.exitCode}`
          }\n`,
          tone: "muted" as const,
        },
      ]).flat()}
      lines={6}
      empty="None"
      label="Its jobs"
    />
  );
}

function Files({ call, done }: { call: ShownCall; done: Outcome }): ReactNode {
  const path = str(call.input?.path) || ".";
  if (done.kind !== "done") {
    return (
      <CodeBlock
        className="step-block"
        title={
          <span>
            Listed <code>{path}</code>
          </span>
        }
        actions={<Status done={done} />}
        code={why(done) ?? []}
      />
    );
  }
  const entries = listOf<Entry>(done.value, "entries");
  return (
    <CodeBlock
      className="step-block"
      title={
        <span>
          Listed <code>{path}</code>
        </span>
      }
      actions={
        <span className="step-status">{entries.length} item{entries.length === 1 ? "" : "s"}</span>
      }
      code={entries.flatMap((e): CodePart[] =>
        e.type === "directory"
          ? [{ text: `${e.name}/\n`, tone: "accent" as const }]
          : [{ text: e.name }, { text: `  ${bytes(e.size)}\n`, tone: "muted" as const }]
      )}
      lines={8}
      empty="Empty"
      label={`What's in ${path}`}
    />
  );
}

function Read({ call, done }: { call: ShownCall; done: Outcome }): ReactNode {
  const path = str(call.input?.path);
  const read = done.kind === "done"
    ? done.value as { content?: string; encoding?: string; size?: number; truncated?: boolean }
    : undefined;
  return (
    <CodeBlock
      className="step-block"
      title={
        <span>
          Read <code>{path}</code>
        </span>
      }
      actions={read?.size !== undefined
        ? <span className="step-status">{bytes(read.size)}{read.truncated ? ", in part" : ""}</span>
        : <Status done={done} />}
      code={why(done) ??
        (read?.encoding === "base64" ? [{ text: "Not text", tone: "muted" }] : read?.content ?? "")}
      lines={8}
      empty="It's empty"
      label={`What ${path} says`}
    />
  );
}

function Write({ call, done }: { call: ShownCall; done: Outcome }): ReactNode {
  const path = str(call.input?.path);
  const content = str(call.input?.content);
  const written = done.kind === "done" && record(done.value)
    ? done.value as { size?: number }
    : undefined;
  const base64 = call.input?.encoding === "base64";
  return (
    <CodeBlock
      className="step-block step-change"
      title={
        <span className="step-file">
          <Icon name="pencil" size={13} />
          {written ? "Wrote" : "Writes"} <code>{path}</code>
        </span>
      }
      actions={written?.size !== undefined
        ? <span className="step-status">{bytes(written.size)}</span>
        : <Status done={done} />}
      code={[
        ...(why(done) ? [...why(done)!, { text: "\n" }] : []),
        ...(base64
          ? [{ text: "Not text", tone: "muted" as const }]
          : content
          ? [{ text: content.replace(/\n?$/, "\n"), tone: "added" as const }]
          : [{ text: "An empty file", tone: "muted" as const }]),
      ]}
      lines={12}
      label={`What goes in ${path}`}
    />
  );
}

function Edit({ call, done }: { call: ShownCall; done: Outcome }): ReactNode {
  const path = str(call.input?.path);
  const diff = lineDiff(str(call.input?.old), str(call.input?.new), 2);
  const added = diff.filter((l) => "tone" in l && l.tone === "added").length;
  const removed = diff.filter((l) => "tone" in l && l.tone === "removed").length;
  const edited = done.kind === "done" && record(done.value);
  return (
    <CodeBlock
      className="step-block step-change"
      title={
        <span className="step-file">
          <Icon name="pencil" size={13} />
          {edited ? "Edited" : "Edits"} <code>{path}</code>
        </span>
      }
      actions={edited
        ? (
          <span className="step-status">
            <span className="step-ok">+{added}</span> <span className="step-bad">−{removed}</span>
          </span>
        )
        : <Status done={done} />}
      code={[
        ...(why(done) ? [...why(done)!, { text: "\n" }] : []),
        ...diff.map((line): CodePart =>
          "skipped" in line
            ? { text: `⋯ ${line.skipped} line${line.skipped === 1 ? "" : "s"}\n`, tone: "muted" }
            : { text: `${line.text}\n`, ...(line.tone ? { tone: line.tone } : {}) }
        ),
      ]}
      lines={16}
      label={`What changed in ${path}`}
    />
  );
}

function Search({ call, done }: { call: ShownCall; done: Outcome }): ReactNode {
  const query = str(call.input?.query);
  const results = done.kind === "done" ? listOf<SearchResult>(done.value, "results") : [];
  return (
    <div className="step-search">
      <Line icon="search" status={done.kind === "done" ? undefined : <Status done={done} />}>
        Searched the web for <b>“{query}”</b>
      </Line>
      {done.kind === "failed" || done.kind === "missing"
        ? <p className="step-why">{done.text}</p>
        : null}
      {results.length
        ? (
          <ol className="step-results">
            {results.slice(0, 6).map((r, i) => {
              const href = safeHref(r.url);
              let host = r.url;
              try {
                host = new URL(r.url).hostname.replace(/^www\./, "");
              } catch { /* Shown as it is. */ }
              return (
                <li key={i}>
                  {href
                    ? (
                      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                        {r.title || host}
                        <Icon name="external" size={12} />
                      </a>
                    )
                    : <span>{r.title || r.url}</span>}
                  <span className="step-host">{host}</span>
                  {r.snippet ? <p>{r.snippet}</p> : null}
                </li>
              );
            })}
            {results.length > 6
              ? <li className="step-more">and {results.length - 6} more</li>
              : null}
          </ol>
        )
        : done.kind === "done"
        ? <p className="step-why">Nothing found.</p>
        : null}
    </div>
  );
}

/** A browser action, in a few words: "navigate example.com", "click", "type". */
const action = (a: Record<string, unknown>) => {
  const kind = str(a.action) || str(a.type) || Object.keys(a)[0] || "step";
  const url = str(a.url);
  let host = url;
  try {
    host = url ? new URL(url).hostname : "";
  } catch { /* As it is. */ }
  return host ? `${kind} ${host}` : kind;
};

function Browser({ call, done }: { call: ShownCall; done: Outcome }): ReactNode {
  const actions = Array.isArray(call.input?.actions)
    ? call.input.actions as Record<string, unknown>[]
    : [];
  const page = done.kind === "done"
    ? done.value as { currentUrl?: string; title?: string; success?: boolean }
    : undefined;
  const href = page?.currentUrl ? safeHref(page.currentUrl) : undefined;
  return (
    <div className="step-search">
      <Line
        icon="globe"
        status={done.kind === "done"
          ? (page?.success === false ? <Badge tone="destructive">stopped early</Badge> : undefined)
          : <Status done={done} />}
      >
        Used the browser: {actions.map(action).join(" · ") || "a step"}
      </Line>
      {href
        ? (
          <p className="step-page">
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {page?.title || page?.currentUrl}
              <Icon name="external" size={12} />
            </a>
          </p>
        )
        : null}
      {done.kind === "failed" || done.kind === "missing"
        ? <p className="step-why">{done.text}</p>
        : null}
    </div>
  );
}

const VIEWS: Record<string, (props: { call: ShownCall; done: Outcome }) => ReactNode> = {
  terminal: Terminal,
  start_job: StartJob,
  list_jobs: Jobs,
  stop_job: Jobs,
  job_logs: Logs,
  list_files: Files,
  read_file: Read,
  write_file: Write,
  edit_file: Edit,
  web_search: Search,
  browser: Browser,
};

/** Which computer it ran on, where the space has several: the one named, or the one that answered. */
const ranOn = (call: ShownCall, done: Outcome) =>
  str(call.input?.computer) ||
  (done.kind === "done" && record(done.value) ? str(done.value.computer) : "");

export const stepView = (call: ShownCall, ctx: ViewContext<ReactNode>): ReactNode => {
  const View = VIEWS[call.name];
  if (!View) return null;
  const done = ctx.hints.running === true ? { kind: "running" as const } : outcome(call);
  const on = ranOn(call, done);
  return (
    <div className="step-computer" data-tool={call.name}>
      <style href="computers-web" precedence="copilotz">{STYLE}</style>
      {on
        ? (
          <p className="step-on" title="The computer it ran on">
            <Icon name="computer" size={12} /> {on}
          </p>
        )
        : null}
      <View call={call} done={done} />
    </div>
  );
};
