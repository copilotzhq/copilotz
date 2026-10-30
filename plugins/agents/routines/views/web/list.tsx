/**
 * A space's routines (kind `routines`: its Routines tab, item `{ _id }`,
 * the space): each one who it asks, when, when it runs next ("in 3 hours",
 * "Mon, 9:00 AM") and how its last run went, opening its page; "Run now",
 * pausing, resuming, changing and deleting it from its row, for its maker
 * and those who manage the space. Those who may write there make one (from
 * scratch or an example). With none yet, it says what a routine is with
 * examples to start from. In a side panel, the same, compact.
 */
import { type ReactNode, useEffect, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Icon,
  IconButton,
  Menu,
  type MenuItem,
  message,
  Notice,
  Skeleton,
  Time,
} from "../../../../../hosts/web/mod.ts";
import type { Team } from "../../../chat/contract.ts";
import type { Listed } from "../../collections/routine.ts";
import { describe, localZone, soon } from "../../shared/schedule.ts";
import { DeleteRoutine } from "./delete.tsx";
import { NewRoutine } from "./new.tsx";
import { type Example, EXAMPLES, routinePath, standingOf, threadPath } from "./routines.ts";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;
type Place = { _id: string; name: string; kind: string; can?: string[]; archived?: string };

const placeName = (p: Pick<Place, "name" | "kind">) => p.kind === "personal" ? "Personal" : p.name;

/** Now, again every half minute: what "in 3 hours" is said from. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export const routinesView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const space = item._id ?? (typeof ctx.hints.in === "string" ? ctx.hints.in : "");
  const routines = ctx.db.collection("routine").query<Listed[]>("list", { in: space }).value;
  const team = ctx.db.collection("thread").query<Team>("agents", { in: space }).value;
  const places = ctx.db.collection("space").query<Place[]>("reached", {}).value;
  const compact = ctx.hints.mode === "panel";
  const style = <style href="routines-web" precedence="copilotz">{STYLE}</style>;
  if (!routines || !team || !places) {
    return (
      <div className="routines" aria-busy="true">
        {style}
        {[0, 1, 2].map((i) => <Skeleton key={i} height={compact ? 56 : 68} radius="lg" />)}
      </div>
    );
  }
  const place = places.find((p) => p._id === space);
  return (
    <>
      {style}
      <Routines
        space={space}
        where={place ? placeName(place) : "this space"}
        writes={!!place?.can?.includes("write") && !place.archived}
        routines={routines}
        team={team}
        compact={compact}
        call={ctx.call}
      />
    </>
  );
};

function Routines(
  { space, where, writes, routines, team, compact, call }: {
    space: string;
    where: string;
    /** Whether the person may make routines here. */
    writes: boolean;
    routines: Listed[];
    team: Team;
    compact: boolean;
    call: Call;
  },
): ReactNode {
  const [making, setMaking] = useState<{ example?: Example }>();
  const [fresh, setFresh] = useState<string>();
  const [deleting, setDeleting] = useState<Listed>();
  const [ran, setRan] = useState<{ name: string; thread?: string; error?: string }>();
  const now = useNow();
  const here = localZone();
  const named = (id: string) => team.agents[id]?.name || id;
  const make = (example?: Example) => setMaking({ ...(example ? { example } : {}) });
  const sorted = [...routines].sort((a, b) =>
    Number(!!a.paused || !a.next) - Number(!!b.paused || !b.next) ||
    (a.next ?? "").localeCompare(b.next ?? "") || a.name.localeCompare(b.name)
  );

  const dialog = (
    <Dialog
      open={!!making}
      onClose={() => setMaking(undefined)}
      size="lg"
      title={`New routine in ${where}`}
      description="It asks an agent here on a schedule, as you."
    >
      {making
        ? (
          <NewRoutine
            space={space}
            team={team}
            {...(making.example ? { example: making.example } : {})}
            call={call}
            done={(routine) => {
              setMaking(undefined);
              setFresh(routine);
            }}
          />
        )
        : null}
    </Dialog>
  );

  if (!routines.length) {
    return (
      <div className={`routines${compact ? " routines-compact" : ""}`}>
        <EmptyState
          icon="refresh"
          tone="primary"
          title="Ask agents things on a schedule"
          className="routines-empty"
          action={writes && team.here.length
            ? <Button variant="primary" icon="plus" onClick={() => make()}>New routine</Button>
            : null}
        >
          A routine sends a message to an agent on a schedule: every weekday at 9:00, ask{" "}
          {team.here[0] ? `@${team.here[0]}` : "an agent"}{" "}
          for the news. It runs as whoever made it, and each run's answer lands in {where}'s chats.
          {!writes ? ` Those who may write in ${where} make them.` : ""}
        </EmptyState>
        {writes && team.here.length
          ? (
            <ul className="routines-examples" aria-label="Start from an example">
              {EXAMPLES.map((example) => (
                <li key={example.name}>
                  <button type="button" className="routines-example" onClick={() => make(example)}>
                    <span className="routines-example-when">
                      <Icon name="refresh" size={13} />
                      {example.said}
                    </span>
                    <b>{example.name}</b>
                    <span>{example.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          )
          : null}
        {dialog}
      </div>
    );
  }

  const row = (r: Listed) => {
    const standing = standingOf(r);
    const zone = "timezone" in r.schedule ? r.schedule.timezone : here;
    const next = r.next && !r.paused ? new Date(r.next) : undefined;
    const quiet = standing.key === "paused" || standing.key === "done";
    const items: (MenuItem | "separator")[] = [
      { label: "Open", icon: "external", href: routinePath(r._id) },
      ...(r.last?.thread
        ? [{
          label: "Open its last chat",
          icon: "chat" as const,
          href: threadPath(r.last.thread, space),
        }]
        : []),
      ...(r.editable
        ? [
          {
            label: "Run now",
            icon: "play" as const,
            onSelect: () => void runNow(r),
          },
          { label: "Edit", icon: "pencil" as const, href: routinePath(r._id, true) },
          r.paused
            ? {
              label: "Resume",
              icon: "play" as const,
              onSelect: () =>
                void call("routine.resume", { routine: r._id }).catch((e) =>
                  setRan({ name: r.name, error: message(e) })
                ),
            }
            : {
              label: "Pause",
              icon: "pause" as const,
              onSelect: () =>
                void call("routine.pause", { routine: r._id }).catch((e) =>
                  setRan({ name: r.name, error: message(e) })
                ),
            },
          "separator" as const,
          {
            label: "Delete…",
            icon: "trash" as const,
            tone: "destructive" as const,
            onSelect: () => setDeleting(r),
          },
        ]
        : []),
    ];
    return (
      <li key={r._id} className="routines-item" data-fresh={fresh === r._id || undefined}>
        <div className="routines-row" data-quiet={quiet || undefined}>
          <Avatar
            name={named(r.agent)}
            kind="agent"
            icon={team.agents[r.agent]?.icon}
            size={compact ? 28 : 34}
          />
          <span className="routines-row-text">
            <span className="routines-row-name">
              {/* The whole row opens it; what's linked inside, its chat. */}
              <a className="routines-row-link" href={routinePath(r._id)}>{r.name}</a>
              {standing.key !== "set" ? <Badge tone={standing.tone}>{standing.label}</Badge> : null}
            </span>
            <span className="routines-row-when">
              {describe(r.schedule, { here })} · asks <b>{named(r.agent)}</b>
            </span>
            {next
              ? <span className="routines-row-soon">Next {soon(next, zone, { now })}</span>
              : null}
          </span>
          <span className="routines-row-next">
            {next
              ? (
                <>
                  <span>Next</span>
                  <strong title={next.toLocaleString()}>{soon(next, zone, { now })}</strong>
                </>
              )
              : <span>{r.paused ? "Paused" : "Not set to run"}</span>}
            {r.last
              ? r.last.thread
                ? (
                  <a
                    className="routines-row-last"
                    data-tone={r.last.outcome}
                    href={threadPath(r.last.thread, space)}
                    title="Open the chat it posted in"
                  >
                    {r.last.outcome === "sent" ? "Ran" : "Failed"} <Time at={r.last.at} long />
                    <Icon name="chat" size={12} />
                  </a>
                )
                : (
                  <span className="routines-row-last" data-tone={r.last.outcome}>
                    {r.last.outcome === "sent" ? "Ran" : "Failed"} <Time at={r.last.at} long />
                  </span>
                )
              : null}
          </span>
        </div>
        <span className="routines-row-actions">
          {r.editable && !compact
            ? (
              <IconButton
                icon="play"
                label={`Run “${r.name}” now`}
                size="sm"
                onClick={() => void runNow(r)}
              />
            )
            : null}
          <Menu label={`${r.name}: more`} align="end" size="sm" items={items} />
        </span>
      </li>
    );
  };

  async function runNow(r: Listed) {
    setRan(undefined);
    try {
      const done = await call<{ outcome: string; thread?: string; error?: string }>(
        "routine.run",
        { routine: r._id },
      );
      setRan({
        name: r.name,
        ...(done.thread ? { thread: done.thread } : {}),
        ...(done.error ? { error: done.error } : {}),
      });
    } catch (e) {
      setRan({ name: r.name, error: message(e) });
    }
  }

  return (
    <div className={`routines${compact ? " routines-compact" : ""}`}>
      {compact ? null : (
        <div className="routines-head">
          <p className="routines-intro">
            Messages sent to agents here on a schedule, each as whoever made it. Each run's chat is
            in Chats.
          </p>
          {writes && team.here.length
            ? <Button variant="primary" icon="plus" onClick={() => make()}>New routine</Button>
            : null}
        </div>
      )}
      {ran
        ? (
          <Notice
            tone={ran.error ? "warning" : "success"}
            role="status"
            title={ran.error ? `“${ran.name}” didn't run` : `“${ran.name}” ran`}
            action={
              <>
                {ran.thread
                  ? (
                    <Button size="sm" icon="chat" href={threadPath(ran.thread, space)}>
                      Open the chat
                    </Button>
                  )
                  : null}
                <IconButton
                  icon="close"
                  label="Dismiss"
                  size="sm"
                  onClick={() => setRan(undefined)}
                />
              </>
            }
          >
            {ran.error ?? "Its message went to the agent; the answer comes in its chat."}
          </Notice>
        )
        : null}
      <ul className="routines-list">{sorted.map(row)}</ul>
      {compact && writes && team.here.length
        ? (
          <Button size="sm" variant="ghost" icon="plus" onClick={() => make()}>
            New routine
          </Button>
        )
        : null}
      {dialog}
      {deleting
        ? (
          <DeleteRoutine
            open
            onClose={() => setDeleting(undefined)}
            routine={deleting._id}
            name={deleting.name}
            call={call}
          />
        )
        : null}
    </div>
  );
}
