/**
 * An agent's page (kind `agent`, at `/agent/<id>`): who it is (its emoji,
 * its name and what it's called by, what it does, where it belongs), where
 * it works among the person's spaces (its role there, and where it answers
 * new chats), and what it's told: its instructions, model and tools. "Ask"
 * starts a chat where it works, `@name` ready. Those who manage where it
 * belongs change it in place (`?edit=1` opens it so) and delete it, after
 * a question that says it leaves every space it works in. The app's own
 * agents are read only; a manager starts a new agent from one. Its menu
 * adds it to another space they manage, and has it answer new chats where
 * the person is.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Avatar,
  Badge,
  Button,
  Card,
  DetailList,
  Dialog,
  EmptyState,
  go,
  Icon,
  IconButton,
  LongText,
  Menu,
  type MenuItem,
  message,
  Notice,
  openPalette,
  Page,
  Skeleton,
  Title,
} from "../../../../../hosts/web/mod.ts";
import type { Agent, Team } from "../../../chat/contract.ts";
import { AgentFields, type Draft } from "./agent-fields.tsx";
import { spaceStep } from "./agent-steps.tsx";
import { agentPath, listed, type Options, shownAs } from "./agents.ts";
import { managed, manages, type Place, placeName, placePath } from "./places.ts";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** A membership, as the spaces plugin keeps it: the agent works in `space` as `role`. */
type Seat = { _id: string; space: string; member: string; role: string; on?: string };

export const agentView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const id = item._id ?? "";
  const here = typeof ctx.hints.in === "string" ? ctx.hints.in : undefined;
  const roster = ctx.db.collection("thread").query<Team>("agents", {
    ...(here ? { in: here } : {}),
    names: [id],
  }).value;
  const places = ctx.db.collection("space").query<Place[]>("reached", {}).value;
  const options = ctx.db.collection("agent").query<Options>("options", {}).value;
  const seats = ctx.db.collection<Seat>("member").find({ member: `agent:${id}` }).value;
  const style = <style href="team-web" precedence="copilotz">{STYLE}</style>;
  if (!roster || !places || !options || !seats) {
    return (
      <Page
        title={<Skeleton width={200} height={30} />}
        leading={<Skeleton width={52} height={52} />}
      >
        {style}
        <div className="agent-page" aria-busy="true">
          <Skeleton height={64} radius="xl" />
          <Skeleton height={160} radius="xl" />
        </div>
      </Page>
    );
  }
  const agent = roster.agents[id];
  if (!agent) {
    return (
      <div className="agent-missing">
        {style}
        <Title text="No such agent" />
        <EmptyState
          icon="bot"
          heading="h1"
          title="No agent here by that name"
          action={<Button variant="primary" icon="compose" href="/">Go home</Button>}
        >
          It may have been deleted, or it works only in spaces you're not in.
        </EmptyState>
      </div>
    );
  }
  const query = (ctx.hints.query ?? {}) as Record<string, string>;
  return (
    <>
      {style}
      <AgentPage
        key={id}
        id={id}
        agent={agent}
        here={places.find((p) => p._id === here)}
        answers={!!here && roster.here.includes(id) && roster.default.includes(id)}
        places={places}
        seats={seats.filter((s) => !s.on)}
        options={options}
        editing={query.edit === "1"}
        call={ctx.call}
      />
    </>
  );
};

function AgentPage(
  { id, agent, here, answers, places, seats, options, editing: asked, call }: {
    id: string;
    agent: Agent;
    /** The space the person is in. */
    here?: Place;
    /** Whether it answers new chats there. */
    answers: boolean;
    places: Place[];
    /** Where it works, among the spaces the person reaches. */
    seats: Seat[];
    options: Options;
    /** The address asks for it changed (`?edit=1`). */
    editing: boolean;
    call: Call;
  },
): ReactNode {
  const { name, icon } = shownAs(id, agent);
  const home = agent.in ? places.find((p) => p._id === agent.in) : undefined;
  const edits = !!home && manages(home);
  const [editing, setEditing] = useState(asked && edits);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();
  const app = !agent.in;
  const placeOf = (space: string) => places.find((p) => p._id === space);
  const working = seats.flatMap((s) => {
    const place = placeOf(s.space);
    return place ? [{ seat: s, place }] : [];
  });
  const mine = managed(places);
  const elsewhere = mine.filter((p) => !seats.some((s) => s.space === p._id));
  const seatHere = here && seats.find((s) => s.space === here._id);
  // Back to the space the person is in, if it works there; else to where it belongs.
  const back = seatHere ? here : home;
  // Where asking it starts a chat: here if it answers chats here, else where it does.
  const ask = seatHere?.role === "editor"
    ? here
    : working.find((w) => w.seat.role === "editor" && !w.place.archived)?.place;
  const askAt = (place: Place) =>
    `/?in=${encodeURIComponent(place._id)}&to=${encodeURIComponent(id)}`;
  const done = () => {
    setEditing(false);
    if (asked) go(agentPath(id));
  };
  const addStep = () =>
    openPalette(spaceStep({
      title: `Add ${name} to…`,
      note: "It works there at once, as an editor: it answers chats there and adds to them.",
      places: elsewhere,
      pick: (place) =>
        call("member.set", {
          space: place._id,
          member: { kind: "agent", id },
          role: "editor",
        }),
    }));
  const fromStep = () =>
    openPalette(spaceStep({
      title: `New agent like ${name}, in…`,
      note: "It starts with its words, model and tools; it belongs to the space you pick.",
      places: mine,
      pick: (place, palette) =>
        palette.dialog({
          title: `New agent in ${placeName(place)}`,
          description: `Starting from ${name}.`,
          view: "agent.add",
          item: { _id: place._id },
          hints: { in: place._id, mode: "new", from: id },
        }),
    }));
  const more: (MenuItem | "separator")[] = [
    ...(here && seatHere?.role === "editor" && !answers && manages(here)
      ? [{
        label: `Make it answer new chats in ${placeName(here)}`,
        icon: "chat" as const,
        onSelect: () =>
          void call("space.agent", { space: here._id, agent: id }).catch((e) =>
            setError(message(e))
          ),
      }]
      : []),
    ...(elsewhere.length
      ? [{ label: "Add to a space…", icon: "plus" as const, onSelect: addStep }]
      : []),
    ...(app && mine.length
      ? [{ label: "Start a new agent from it…", icon: "sparkles" as const, onSelect: fromStep }]
      : []),
    ...(edits
      ? [
        "separator" as const,
        {
          label: `Delete ${name}…`,
          icon: "trash" as const,
          tone: "destructive" as const,
          onSelect: () => setDeleting(true),
        },
      ]
      : []),
  ];
  return (
    <Page
      className="agent-page-frame"
      leading={<Avatar name={name} kind="agent" icon={icon} size={52} className="agent-mark" />}
      title={name}
      back={back ? { href: placePath(back._id, "members"), label: placeName(back) } : undefined}
      badges={
        <>
          <Badge variant="outline" className="agent-page-handle">@{id}</Badge>
          {app
            ? <Badge>Part of the app</Badge>
            : <Badge tone="primary">{home ? `Made in ${placeName(home)}` : "Made elsewhere"}
            </Badge>}
          {answers && here ? <Badge tone="success">Answers new chats here</Badge> : null}
        </>
      }
      description={agent.description}
      actions={editing ? null : (
        <>
          {ask
            ? (
              <>
                <Button variant="primary" icon="chat" href={askAt(ask)} className="agent-wide">
                  Ask {name}
                </Button>
                <IconButton
                  icon="chat"
                  label={`Ask ${name}`}
                  variant="primary"
                  href={askAt(ask)}
                  className="agent-narrow"
                />
              </>
            )
            : null}
          {edits
            ? (
              <>
                <Button icon="pencil" className="agent-wide" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <IconButton
                  icon="pencil"
                  label={`Edit ${name}`}
                  variant="outline"
                  className="agent-narrow"
                  onClick={() => setEditing(true)}
                />
              </>
            )
            : null}
          {more.length ? <Menu label={`${name}: more`} align="end" items={more} /> : null}
        </>
      )}
    >
      <Title text={name} />
      {error
        ? <Notice tone="destructive" role="alert" className="agent-page-error">{error}</Notice>
        : null}
      {editing
        ? <Edit id={id} agent={agent} options={options} call={call} done={done} />
        : (
          <div className="agent-page">
            {app
              ? (
                <Notice
                  tone="neutral"
                  icon="lock"
                  action={mine.length
                    ? <Button size="sm" icon="sparkles" onClick={fromStep}>Start from it</Button>
                    : null}
                >
                  Part of the app: it's set up in code, so it isn't changed here. To have one of
                  your own like it, start a new agent from it.
                </Notice>
              )
              : !edits
              ? (
                <p className="agent-page-note">
                  <Icon name="lock" size={14} />
                  {home
                    ? `Those who manage ${placeName(home)} change it.`
                    : "Those who manage the space it belongs to change it."}
                </p>
              )
              : null}
            <section className="agent-section" aria-labelledby="agent-works">
              <div className="agent-section-head">
                <h2 id="agent-works" className="agent-section-title">
                  Works in <span className="agent-count">{working.length}</span>
                </h2>
                {elsewhere.length
                  ? (
                    <Button size="sm" variant="ghost" icon="plus" onClick={addStep}>
                      Add to a space
                    </Button>
                  )
                  : null}
              </div>
              {working.length
                ? (
                  <ul className="agent-seats">
                    {working.map(({ seat, place }) => (
                      <li key={seat._id}>
                        <a className="agent-seat" href={placePath(place._id, "members")}>
                          {place.kind === "personal"
                            ? (
                              <span className="agent-seat-personal">
                                <Icon name="person" size={15} />
                              </span>
                            )
                            : <Avatar name={place.name} kind="space" size={28} />}
                          <span className="agent-seat-name">{placeName(place)}</span>
                          {place.agent === id
                            ? <Badge tone="primary">Answers new chats</Badge>
                            : null}
                          <Badge variant="outline">
                            {seat.role === "viewer" ? "Viewer" : "Editor"}
                          </Badge>
                          <Icon name="chevron" size={15} />
                        </a>
                      </li>
                    ))}
                  </ul>
                )
                : <p className="agent-none">It doesn't work in any of your spaces.</p>}
            </section>
            <section className="agent-section" aria-labelledby="agent-told">
              <h2 id="agent-told" className="agent-section-title">Instructions</h2>
              <Card className="agent-instructions-read">
                <LongText text={agent.instructions} lines={12} />
              </Card>
            </section>
            <section className="agent-section" aria-labelledby="agent-uses">
              <h2 id="agent-uses" className="agent-section-title">Model and tools</h2>
              <DetailList
                item={{}}
                fields={[
                  {
                    field: "model",
                    label: "Model",
                    value: <code>{modelName(agent.model)}</code>,
                  },
                  ...(agent.effort
                    ? [{ field: "effort", label: "Thinks", value: `${agent.effort} effort` }]
                    : []),
                  {
                    field: "tools",
                    label: "Tools",
                    value: agent.tools?.length
                      ? <ToolList tools={agent.tools} options={options} />
                      : "None: it only talks.",
                  },
                ]}
              />
            </section>
          </div>
        )}
      {edits
        ? (
          <Delete
            open={deleting}
            onClose={() => setDeleting(false)}
            id={id}
            name={name}
            spaces={working.map((w) => placeName(w.place))}
            after={home ? placePath(home._id, "members") : "/"}
            call={call}
          />
        )
        : null}
    </Page>
  );
}

/** How many tools show before "Show all". */
const TOOLS = 8;

/** The tools it uses, each with what it does; past a few, the rest on a press. */
function ToolList({ tools, options }: { tools: string[]; options: Options }): ReactNode {
  const [all, setAll] = useState(false);
  const shown = all ? tools : tools.slice(0, TOOLS);
  return (
    <div className="agent-tools-read">
      <ul className="agent-tool-list">
        {shown.map((tool) => {
          const about = options.tools.find((t) => t.name === tool)?.description;
          return (
            <li key={tool} title={about}>
              <code>{tool}</code>
              <span>{about ?? ""}</span>
            </li>
          );
        })}
      </ul>
      {tools.length > TOOLS
        ? (
          <Button
            variant="link"
            size="sm"
            iconEnd={all ? undefined : "chevron-down"}
            onClick={() => setAll(!all)}
          >
            {all ? "Show fewer" : `Show all ${tools.length}`}
          </Button>
        )
        : null}
    </div>
  );
}

/** A model, as it's named: `"provider/model"`, an alias, or a list tried in order. */
const modelName = (model: Agent["model"]): string =>
  typeof model === "string"
    ? model
    : Array.isArray(model)
    ? model.map(modelName).join(", then ")
    : modelName(model.model);

/** Changing it, in place: its fields, then Save (what changed only) or Cancel. */
function Edit(
  { id, agent, options, call, done }: {
    id: string;
    agent: Agent;
    options: Options;
    call: Call;
    done(): void;
  },
): ReactNode {
  const was: Draft = {
    name: shownAs(id, agent).name,
    icon: agent.icon ?? "",
    description: agent.description ?? "",
    instructions: agent.instructions,
    model: typeof agent.model === "string" ? agent.model : options.models[0] ?? "",
    tools: agent.tools ?? [],
  };
  const [draft, setDraft] = useState(was);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const changed = changes(was, draft);
  const ready = !!draft.name.trim() && !!draft.model;
  return (
    <form
      className="agent-edit"
      aria-label={`Change ${was.name}`}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!ready || busy) return;
        if (!Object.keys(changed).length) return done();
        setBusy(true);
        setError(undefined);
        try {
          await call("agent.update", { agent: id, ...changed });
          done();
        } catch (e) {
          setError(message(e));
          setBusy(false);
        }
      }}
    >
      <Card className="agent-edit-card">
        <AgentFields
          value={draft}
          onChange={(patch) => setDraft((now) => ({ ...now, ...patch }))}
          options={options}
          handle={id}
          call={call}
          autoFocus
          disabled={busy}
        />
      </Card>
      <div className="agent-edit-end">
        <p className="agent-form-note" aria-live="polite">
          {error
            ? <span className="agent-error" role="alert">{error}</span>
            : `It keeps its name in chats, @${id}, whatever it's shown as.`}
        </p>
        <Button onClick={done} disabled={busy}>Cancel</Button>
        <Button
          type="submit"
          variant="primary"
          icon="check"
          loading={busy}
          disabled={!ready || !Object.keys(changed).length}
        >
          Save changes
        </Button>
      </div>
    </form>
  );
}

/** What changed between what an agent was and what's typed, as `agent.update` takes it. */
function changes(was: Draft, now: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of ["name", "icon", "description", "instructions", "model"] as const) {
    const value = now[field].trim();
    if (value !== was[field].trim() && (value || field !== "name")) out[field] = value;
  }
  if (now.tools.join() !== was.tools.join()) out.tools = now.tools;
  return out;
}

/** Deleting it, once they've read what it means: it leaves every space it works in. */
function Delete(
  { open, onClose, id, name, spaces, after, call }: {
    open: boolean;
    onClose(): void;
    id: string;
    name: string;
    /** Where it works, that the person sees. */
    spaces: string[];
    /** Where to go once it's gone. */
    after: string;
    call: Call;
  },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={`Delete ${name}?`}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="destructive"
            icon="trash"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(undefined);
              try {
                await call("agent.delete", { agent: id });
                onClose();
                go(after);
              } catch (e) {
                setError(message(e));
                setBusy(false);
              }
            }}
          >
            Delete {name}
          </Button>
        </>
      }
    >
      <ul className="agent-delete-means">
        <li>
          <b>It leaves every space it works in</b>
          {spaces.length ? <>, {listed(spaces)} among them.</> : "."}{" "}
          Where it answered new chats, another agent there does.
        </li>
        <li>
          <b>Nobody can ask it anything again,</b> and it can't be brought back.
        </li>
        <li>
          <b>Chats it was in stay as they are,</b> with what it said.
        </li>
      </ul>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
    </Dialog>
  );
}
