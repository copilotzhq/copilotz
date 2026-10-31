/**
 * A routine's page (kind `routine`, at `/routine/<id>`): what it does (what
 * it asks, whom, when, with its next runs, where it posts, who made it), how
 * it stands (paused, done, failing, or unable to run because its maker left
 * the space: then those who manage it take it over), and its runs, newest
 * first, each with how it went and its chat. What other plugins say about it
 * shows between (`routinePanels`: a computer's, what it may do on its own). Its maker and those who manage
 * the space run it now, pause or resume it, change it in place (`?edit=1`)
 * and delete it.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  go,
  Icon,
  IconButton,
  LazyView,
  Menu,
  type MenuItem,
  message,
  Notice,
  Page,
  Skeleton,
  Time,
  Title,
} from "../../../../../hosts/web/mod.ts";
import type { Team, Thread } from "../../../chat/contract.ts";
import type { Listed, Routine } from "../../collections/routine.ts";
import type { RoutineRun } from "../../collections/run.ts";
import { chatTitle } from "../../shared/routines.ts";
import type { RoutinePanel } from "../../contract.ts";
import { describe, localZone, moment, nextRuns, soon } from "../../shared/schedule.ts";
import { DeleteRoutine } from "./delete.tsx";
import { RoutineForm } from "./form.tsx";
import { useNow } from "./list.tsx";
import { pickable } from "./new.tsx";
import { picking, routinePath, routinesTab, standingOf, threadPath } from "./routines.ts";
import { STYLE } from "./style.ts";
import { nameOf, namesIn } from "../../../../access/spaces/contract.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;
type Place = { _id: string; name: string; kind: string; can?: string[]; archived?: string };

const placeName = (p: Pick<Place, "name" | "kind">) => p.kind === "personal" ? "Personal" : p.name;

export const routineView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const id = item._id ?? "";
  const found = ctx.db.collection<Routine>("routine").findOne({ _id: id }).value;
  const space = found?.in;
  const listed = space
    ? ctx.db.collection("routine").query<Listed[]>("list", { in: space }).value
    : undefined;
  const runs = found
    ? ctx.db.collection("routine").query<RoutineRun[]>("runs", { routine: id, limit: 30 }).value
    : undefined;
  const team = space
    ? ctx.db.collection("thread").query<Team>("agents", { in: space }).value
    : undefined;
  const places = ctx.db.collection("space").query<Place[]>("reached", {}).value;
  const style = <style href="routines-web" precedence="copilotz">{STYLE}</style>;
  if (found === null) {
    return (
      <div className="routine-missing">
        {style}
        <Title text="No such routine" />
        <EmptyState
          icon="refresh"
          heading="h1"
          title="No routine here"
          action={<Button variant="primary" icon="home" href="/">Go home</Button>}
        >
          It may have been deleted, or it's in a space you're not in.
        </EmptyState>
      </div>
    );
  }
  const routine = listed?.find((r) => r._id === id);
  if (!found || !routine || !runs || !team || !places) {
    return (
      <Page title={<Skeleton width={240} height={30} />} icon="refresh">
        {style}
        <div className="routine-loading" aria-busy="true">
          <Skeleton height={190} radius="xl" />
          <Skeleton height={120} radius="xl" />
        </div>
      </Page>
    );
  }
  const place = places.find((p) => p._id === routine.in);
  const query = (ctx.hints.query ?? {}) as Record<string, string>;
  // Who made it, and who started its runs, by name.
  const names = namesIn(ctx, [routine.by, ...runs.flatMap((run) => run.by ? [run.by] : [])]);
  // What each run's own chat is called now: its agent may have named it for what it found.
  const chats = routine.post === "new" ? runs.flatMap((run) => run.thread ? [run.thread] : []) : [];
  const named = chats.length
    ? ctx.db.collection<Thread>("thread").find({ _id: { $in: chats } }).value ?? []
    : [];
  const titles = Object.fromEntries(named.flatMap((t) => t.title ? [[t._id, t.title]] : []));
  return (
    <>
      {style}
      <RoutinePage
        key={id}
        routine={routine}
        runs={runs}
        titles={titles}
        team={team}
        place={place}
        manages={!!place?.can?.includes("manage")}
        me={ctx.viewer?.name}
        editing={query.edit === "1" && routine.editable}
        call={ctx.call}
        names={names}
        panels={panelsOf(ctx.resources.routinePanels)}
      />
    </>
  );
};

/** The Views a `routinePanels` resource draws on a routine's page, in order. */
const panelsOf = (given: unknown) =>
  Object.entries((given ?? {}) as Record<string, RoutinePanel | null>)
    .flatMap(([key, panel]) => panel?.view ? [{ ...panel, key }] : [])
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.key.localeCompare(b.key));

function RoutinePage(
  { routine: r, runs, titles, team, place, manages, me, editing, call, names, panels }: {
    routine: Listed;
    runs: RoutineRun[];
    /** The names of its runs' own chats, by chat. */
    titles: Record<string, string>;
    team: Team;
    place?: Place;
    manages: boolean;
    me?: string;
    editing: boolean;
    call: Call;
    names: Record<string, string>;
    panels: (RoutinePanel & { key: string })[];
  },
): ReactNode {
  const [busy, setBusy] = useState<string>();
  const [said, setSaid] = useState<
    { tone: "success" | "warning"; text: string; thread?: string }
  >();
  const [deleting, setDeleting] = useState(false);
  const now = useNow();
  const here = localZone();
  const zone = "timezone" in r.schedule ? r.schedule.timezone : here;
  const where = place ? placeName(place) : "its space";
  const standing = standingOf(r);
  const agent = team.agents[r.agent];
  const agentName = agent?.name || r.agent;
  const next = r.paused ? [] : nextRuns(r.schedule, { from: now, count: 3, since: r.since });
  const maker = r.by === me ? "you" : nameOf(r.by, names);
  const act = async (what: string, action: string, input: Record<string, unknown>) => {
    setBusy(what);
    setSaid(undefined);
    try {
      const done = await call<{ outcome?: string; thread?: string; error?: string }>(action, input);
      if (action === "routine.run") {
        setSaid(
          done.error ? { tone: "warning", text: done.error } : {
            tone: "success",
            text: `Sent to ${agentName}: the answer comes in its chat.`,
            ...(done.thread ? { thread: done.thread } : {}),
          },
        );
      }
    } catch (e) {
      setSaid({ tone: "warning", text: message(e) });
    } finally {
      setBusy(undefined);
    }
  };
  const more: (MenuItem | "separator")[] = r.editable
    ? [
      r.paused
        ? {
          label: "Resume",
          icon: "play",
          onSelect: () => void act("resume", "routine.resume", { routine: r._id }),
        }
        : {
          label: "Pause",
          icon: "pause",
          onSelect: () => void act("pause", "routine.pause", { routine: r._id }),
        },
      ...(r.left && manages && r.by !== me
        ? [{
          label: "Take it over",
          icon: "person" as const,
          onSelect: () => void act("adopt", "routine.update", { routine: r._id, adopt: true }),
        }]
        : []),
      "separator",
      {
        label: "Delete…",
        icon: "trash",
        tone: "destructive",
        onSelect: () => setDeleting(true),
      },
    ]
    : [];
  return (
    <Page
      icon="refresh"
      title={r.name}
      back={{ href: routinesTab(r.in), label: `${where} · Routines` }}
      badges={standing.key !== "set" ? <Badge tone={standing.tone}>{standing.label}</Badge> : null}
      description={describe(r.schedule, { here })}
      actions={editing || !r.editable ? null : (
        <>
          <Button
            variant="primary"
            icon="play"
            className="routine-wide"
            loading={busy === "run"}
            onClick={() => void act("run", "routine.run", { routine: r._id })}
          >
            Run now
          </Button>
          <IconButton
            icon="play"
            label="Run now"
            variant="primary"
            className="routine-narrow"
            loading={busy === "run"}
            onClick={() => void act("run", "routine.run", { routine: r._id })}
          />
          <Button icon="pencil" className="routine-wide" href={routinePath(r._id, true)}>
            Edit
          </Button>
          <IconButton
            icon="pencil"
            label="Edit"
            variant="outline"
            className="routine-narrow"
            href={routinePath(r._id, true)}
          />
          <Menu label={`${r.name}: more`} align="end" items={more} />
        </>
      )}
    >
      <Title text={r.name} />
      {editing
        ? (
          <Card className="routine-edit-card routine-page">
            <RoutineForm
              space={r.in}
              routine={r._id}
              was={{
                name: r.name,
                text: r.text,
                agent: r.agent,
                post: r.post,
                ...(r.chatName ? { chatName: r.chatName } : {}),
              }}
              when={picking(zone, r.schedule)}
              agents={pickable(team)}
              call={call}
              done={() => go(routinePath(r._id))}
              cancel={() => go(routinePath(r._id))}
            />
          </Card>
        )
        : (
          <div className="routine-page">
            {said
              ? (
                <Notice
                  tone={said.tone}
                  role="status"
                  action={said.thread
                    ? (
                      <Button size="sm" icon="chat" href={threadPath(said.thread, r.in)}>
                        Open the chat
                      </Button>
                    )
                    : null}
                >
                  {said.text}
                </Notice>
              )
              : null}
            {r.left
              ? (
                <Notice
                  tone="destructive"
                  title={`${maker === "you" ? "You" : maker} left ${where}`}
                  action={manages && r.by !== me
                    ? (
                      <Button
                        size="sm"
                        loading={busy === "adopt"}
                        onClick={() =>
                          void act("adopt", "routine.update", { routine: r._id, adopt: true })}
                      >
                        Take it over
                      </Button>
                    )
                    : null}
                >
                  A routine sends as whoever made it, so this one can't run. {manages && r.by !== me
                    ? "Take it over to run it as you, or delete it."
                    : "Someone who manages this space can take it over."}
                </Notice>
              )
              : r.last && r.last.outcome !== "sent"
              ? (
                <Notice tone="warning" title="Its last run didn't go">
                  {r.last.error ?? "It couldn't send its message."}
                </Notice>
              )
              : null}
            {r.paused
              ? (
                <Notice
                  tone="neutral"
                  icon="pause"
                  action={r.editable
                    ? (
                      <Button
                        size="sm"
                        icon="play"
                        loading={busy === "resume"}
                        onClick={() => void act("resume", "routine.resume", { routine: r._id })}
                      >
                        Resume
                      </Button>
                    )
                    : null}
                >
                  Paused <Time at={r.paused} long />: it won't run until it's resumed.
                </Notice>
              )
              : null}
            <Card padding="none">
              <dl className="routine-facts">
                <dt>Asks</dt>
                <dd>
                  <p className="routine-said">{r.text}</p>
                </dd>
                <dt>Whom</dt>
                <dd>
                  <a className="routine-who" href={`/agent/${encodeURIComponent(r.agent)}`}>
                    <Avatar name={agentName} kind="agent" icon={agent?.icon} size={26} />
                    <span>{agentName}</span>
                    {agentName !== r.agent ? <small>@{r.agent}</small> : null}
                  </a>
                </dd>
                <dt>When</dt>
                <dd>
                  <span>{describe(r.schedule, { here })}</span>
                  {next.length
                    ? (
                      <ul className="routine-next" aria-label="Its next runs">
                        {next.map((at, i) => (
                          <li key={i} title={moment(at, zone)}>
                            {i === 0 ? `Next ${soon(at, zone, { now })}` : moment(at, zone)}
                          </li>
                        ))}
                      </ul>
                    )
                    : (
                      <span className="routine-note">
                        {r.paused
                          ? "Paused."
                          : "Nothing more to run: give it a new time to run again."}
                      </span>
                    )}
                </dd>
                <dt>Posts</dt>
                <dd>
                  {r.post === "same"
                    ? (
                      <span>
                        Always in the same chat
                        {r.thread
                          ? (
                            <>
                              {" · "}
                              <a href={threadPath(r.thread, r.in)}>open it</a>
                            </>
                          )
                          : ", made on its first run"}
                      </span>
                    )
                    : <span>In a new chat each run, like “{chatTitle(r)}”</span>}
                </dd>
                <dt>Made by</dt>
                <dd>
                  <span>
                    {maker}, <Time at={r.at} long />; it runs as {maker === "you" ? "you" : "them"}
                  </span>
                </dd>
              </dl>
            </Card>
            {panels.map((p) => <LazyView key={p.key} kind={p.view} item={r} fallback={null} />)}
            <section className="routine-runs" aria-labelledby="routine-runs">
              <h2 id="routine-runs">
                Runs <span className="routine-runs-count">{r.runs ?? runs.length}</span>
              </h2>
              {runs.length
                ? (
                  <ul className="routine-run-list">
                    {runs.map((run) => (
                      <li key={run._id} className="routine-run">
                        <span className="routine-run-mark" data-outcome={run.outcome}>
                          <Icon
                            name={run.outcome === "sent"
                              ? "check"
                              : run.outcome === "failed"
                              ? "alert"
                              : "lock"}
                            size={14}
                          />
                        </span>
                        <span className="routine-run-text">
                          <b>
                            {run.outcome === "sent"
                              // A chat of its own says what's in it.
                              ? (r.post === "new" && run.thread && titles[run.thread]) || "Sent"
                              : run.outcome === "failed"
                              ? "Failed"
                              : "Couldn't run"}
                          </b>
                          <span>
                            <Time at={run.at} long />
                            {run.by
                              ? ` · started by ${run.by === me ? "you" : nameOf(run.by, names)}`
                              : " · on schedule"}
                            {run.error ? ` · ${run.error}` : ""}
                            {run.note ? ` · ${run.note}` : ""}
                          </span>
                        </span>
                        {run.thread
                          ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              iconEnd="chevron"
                              href={threadPath(run.thread, r.in)}
                            >
                              Chat
                            </Button>
                          )
                          : <span />}
                      </li>
                    ))}
                  </ul>
                )
                : (
                  <p className="routine-note">
                    It hasn't run yet.{" "}
                    {next[0] ? `Its first run is ${soon(next[0], zone, { now })}.` : ""}
                  </p>
                )}
            </section>
          </div>
        )}
      {r.editable
        ? (
          <DeleteRoutine
            open={deleting}
            onClose={() => setDeleting(false)}
            routine={r._id}
            name={r.name}
            call={call}
            deleted={() => go(routinesTab(r.in))}
          />
        )
        : null}
    </Page>
  );
}
