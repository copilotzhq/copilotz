/**
 * A computer's workspace, in one space's folder: which of the spaces it's
 * in (its desks: the one the person works in, unless they pick another; one
 * alone when `fixed`, as on a space's Computer tab), and its terminal, jobs
 * and files, as tabs. A tab, once opened, stays open while the page is (the
 * terminal keeps what it showed); the one last used opens next time.
 * `compact` in a side panel. Offline, it says how to bring the computer
 * back instead (or, someone else's, who can); a cloud computer asleep, its
 * kind's View says so, and wakes it (at once, as its page opens: `wake`).
 */
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  CodeBlock,
  Icon,
  LazyView,
  Notice,
  Select,
  Skeleton,
  Tabs,
} from "../../../../../hosts/web/mod.ts";
import type { Computer } from "../../collections/computer.ts";
import type { Desk } from "../../collections/desk.ts";
import type { Preview } from "../../collections/preview.ts";
import { FilesTab } from "./files.tsx";
import { JobsTab, useJobs } from "./jobs.tsx";
import type { JobAction, Kind } from "./kinds.ts";
import { previewsAt } from "./previews.ts";
import { folderPath, type Named, nameOf, workOn } from "./names.ts";
import type { Space } from "./page.tsx";
import { TerminalTab } from "./terminal-tab.tsx";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;
type Shown = "terminal" | "jobs" | "files";

const KEY = "copilotz-computer-tab";

const lastTab = (): Shown => {
  try {
    const kept = localStorage.getItem(KEY);
    return kept === "jobs" || kept === "files" ? kept : "terminal";
  } catch {
    return "terminal";
  }
};

/** How often the person says they have a computer open, while its page shows. */
const VIEW_MS = 120_000;

/**
 * Says the person has the computer open (`computer.view`): once it shows
 * (online), then every two minutes while the page is visible, and when it
 * becomes visible again after a while. A computer that sleeps (a cloud
 * computer) stays awake while it's viewed, up to the app's limit; it wakes
 * nothing, and means nothing to a person's own computer.
 */
function useViewing(
  desk: string,
  online: boolean,
  call: { current: Call },
): void {
  useEffect(() => {
    if (!desk || !online || typeof document === "undefined") return;
    let last = 0;
    const view = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < VIEW_MS / 2) return;
      last = Date.now();
      call.current("computer.view", { desk }).catch(() => {});
    };
    view();
    const timer = setInterval(view, VIEW_MS);
    document.addEventListener("visibilitychange", view);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", view);
    };
  }, [desk, online]);
}

/** A space as the picker says it: Personal, or the space's name. */
export const spaceName = (p: Space) => p.kind === "personal" ? "Personal" : p.name;

export function Workspace(
  {
    computer,
    spaces,
    desks,
    here,
    me,
    agents,
    call,
    fixed,
    compact,
    theirs,
    kind,
    wake,
    previews = [],
    jobActions = [],
  }: {
    computer: Computer;
    spaces: Space[];
    desks: Desk[];
    here?: string;
    me?: string;
    /** Agents as they're named, for whose each job is. */
    agents?: Record<string, Named>;
    call: Call;
    /** One space's folder only: no picking another. */
    fixed?: boolean;
    compact?: boolean;
    /** Whose it is, when it isn't the person's: they bring it back online. */
    theirs?: string;
    /** Its kind (a cloud computer's): asleep, its kind's View shows in place of the tabs. */
    kind?: Kind;
    /** Wake it now, if it's asleep (its page opened). */
    wake?: boolean;
    /** What it serves, at addresses of their own (the spaces' previews). */
    previews?: Preview[];
    /** What a job that serves a port can become, beyond a preview (published). */
    jobActions?: JobAction[];
  },
): ReactNode {
  const named = useMemo(() => new Map(spaces.map((p) => [p._id, p])), [spaces]);
  const sorted = useMemo(
    () =>
      [...desks].sort((a, b) => {
        const [pa, pb] = [named.get(a.in), named.get(b.in)];
        return Number(pb?.kind === "personal") - Number(pa?.kind === "personal") ||
          (pa?.name ?? a.folder).localeCompare(pb?.name ?? b.folder);
      }),
    [desks, named],
  );
  const start = sorted.find((d) => d.in === here)?._id ?? sorted[0]?._id ?? "";
  const [deskId, setDesk] = useState(start);
  // Where they work changes (the sidebar): so does the folder shown.
  useEffect(() => setDesk(start), [here, start]);
  const [tab, setTab] = useState<Shown>(lastTab);
  const [opened, setOpened] = useState<Set<Shown>>(() => new Set([tab]));
  const id = useId();
  // The View's `call` is new each time it runs: the work goes through the latest.
  const latest = useRef(call);
  latest.current = call;
  const work = useMemo(
    () => workOn((action, input) => latest.current(action, input), deskId),
    [deskId],
  );
  // A computer that sleeps isn't asked about its jobs while they don't show: asking is using it.
  const jobs = useJobs(work, computer.online && !!deskId, tab === "jobs", !!kind);
  useViewing(deskId, computer.online, latest);
  const desk = sorted.find((d) => d._id === deskId);
  const space = desk?.in ?? "";
  const chosen = named.get(space);
  const folder = desk?.folder ?? "";
  const path = desk ? folderPath(computer, desk.folder) : undefined;
  const running = jobs.list?.filter((j) => j.running).length ?? 0;

  const show = (next: Shown) => {
    setTab(next);
    setOpened((was) => was.has(next) ? was : new Set([...was, next]));
    try {
      localStorage.setItem(KEY, next);
    } catch { /* Kept for this page only. */ }
  };

  return (
    <section
      className={`computer-work${compact ? " computer-work-compact" : ""}`}
      aria-label={`Work on ${nameOf(computer)}`}
    >
      <div className="computer-bar">
        <Tabs
          label="On this computer"
          variant="line"
          value={tab}
          onChange={show}
          panel={`${id}-panel`}
          tabs={[
            { value: "terminal", label: "Terminal", icon: "terminal" },
            {
              value: "jobs",
              label: "Jobs",
              icon: "activity",
              ...(running ? { count: running } : {}),
            },
            { value: "files", label: "Files", icon: "folder" },
          ]}
        />
        {fixed
          ? (
            <span className="computer-space">
              <Icon name="folder" size={14} />
              <span className="computer-space-path" title={path}>
                {path ? <code>{path}</code> : desk ? <code>{folder}</code> : null}
              </span>
            </span>
          )
          : (
            <label className="computer-space">
              <span className="computer-space-label">In</span>
              <Select
                size="sm"
                value={deskId}
                onChange={(event) => setDesk(event.target.value)}
                aria-label="Which space's folder"
              >
                {sorted.length
                  ? sorted.map((d) => {
                    const p = named.get(d.in);
                    return <option key={d._id} value={d._id}>{p ? spaceName(p) : d.folder}</option>;
                  })
                  : <option value="">In no space yet</option>}
              </Select>
              <span className="computer-space-path" title={path}>
                {path ? <code>{path}</code> : desk ? <code>{folder}</code> : null}
              </span>
            </label>
          )}
      </div>
      <div id={`${id}-panel`} role="tabpanel" className="computer-panel">
        {!desk
          ? (
            <Notice tone="neutral" icon="computer" title="In no space yet">
              Agents use a computer in the spaces it's in. Put it in one from that space.
            </Notice>
          )
          : computer.online
          ? (
            // Keyed by desk: another space's folder is another shell, other jobs, other files.
            <div key={deskId} className="computer-tabs">
              {opened.has("terminal")
                ? (
                  <div hidden={tab !== "terminal"} className="computer-tab computer-tab-terminal">
                    <TerminalTab
                      computer={computer}
                      {...(theirs ? { theirs } : {})}
                      space={space}
                      spaceName={chosen ? spaceName(chosen) : "this space"}
                      folder={folder}
                      work={work}
                      active={tab === "terminal"}
                    />
                  </div>
                )
                : null}
              {opened.has("jobs")
                ? (
                  <div hidden={tab !== "jobs"} className="computer-tab">
                    <JobsTab
                      work={work}
                      jobs={jobs}
                      me={me}
                      agents={agents}
                      active={tab === "jobs"}
                      served={{
                        call: (action, input) => latest.current(action, input),
                        space,
                        computer: computer._id,
                        ...(desk ? { desk: desk._id } : {}),
                        ...(path ? { folder: path } : {}),
                        previews: previewsAt(previews, computer._id, space),
                        actions: jobActions,
                      }}
                    />
                  </div>
                )
                : null}
              {opened.has("files")
                ? (
                  <div hidden={tab !== "files"} className="computer-tab">
                    <FilesTab work={work} folder={folder} computer={nameOf(computer)} />
                  </div>
                )
                : null}
            </div>
          )
          : kind
          ? (
            // Asleep (or waking): its kind says so, and wakes it.
            <LazyView
              kind={kind.view}
              item={{ _id: computer._id, desk: deskId, name: nameOf(computer) }}
              hints={{ mode: "asleep", ...(wake ? { wake: true } : {}) }}
              fallback={<Skeleton height={compact ? 180 : 240} radius="xl" />}
            />
          )
          : <Offline name={nameOf(computer)} theirs={theirs} />}
      </div>
    </section>
  );
}

/** How to bring it back; someone else's, who can. */
function Offline({ name, theirs }: { name: string; theirs?: string }): ReactNode {
  const command = "deno task computer";
  if (theirs) {
    return (
      <div className="computer-offline">
        <Notice tone="neutral" icon="computer" title={`${name} is offline`}>
          It's{" "}
          {theirs}'s: its terminal, jobs and files show here once they start it again, and agents
          here can use it then.
        </Notice>
      </div>
    );
  }
  return (
    <div className="computer-offline">
      <Notice tone="neutral" icon="computer" title={`${name} is offline`}>
        Its terminal, jobs and files show here while it's running, and your agents can use it again
        then. To start it, run this on it, from your copy of Copilotz:
      </Notice>
      <CodeBlock
        code={[{ text: "$ ", tone: "muted" }, { text: command }]}
        copy={command}
        label="The command that starts it"
      />
    </div>
  );
}
