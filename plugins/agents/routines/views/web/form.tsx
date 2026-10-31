/**
 * The form a routine is made and changed with: what it sends (as the
 * person, each time), to which of the agents answering in the space, when
 * (the schedule picker, with what it says and its next runs), where it
 * posts (always the same chat, or a new one each run: what those are called,
 * and how many that'd be, when it's a lot), and what it's called (from what
 * it sends, unless they say). Save sends only what changed; what's wrong is
 * said where it is.
 */
import { type ReactNode, useId, useState } from "react";
import { Avatar, Button, Input, message, Textarea } from "../../../../../hosts/web/mod.ts";
import { chatTitle, defaultChatName, nameFrom } from "../../shared/routines.ts";
import { oftenPerDay, type Schedule } from "../../shared/schedule.ts";
import { scheduleOf, SchedulePicker } from "./picker.tsx";
import { type Draft, givenOf, type Picking } from "./routines.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** An agent to pick: what it's called by, shown as, with its emoji. */
export type Pickable = { id: string; name: string; icon?: string };

export function RoutineForm(
  { space, routine, was, when, agents, call, done, cancel }: {
    space: string;
    /** The routine being changed; none when it's new. */
    routine?: string;
    was: Draft;
    when: Picking;
    /** The agents answering in the space. */
    agents: Pickable[];
    call: Call;
    done(routine: string): void;
    cancel?(): void;
  },
): ReactNode {
  const id = useId();
  const [draft, setDraft] = useState(was);
  const [picking, setPicking] = useState(when);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const set = (patch: Partial<Draft>) => setDraft((now) => ({ ...now, ...patch }));
  const fresh = !routine;
  const schedule = scheduleOf(picking);
  const problems: Record<string, string> = {
    ...(!draft.text.trim() ? { text: "Say what it should ask, each time." } : {}),
    ...(!draft.agent ? { agent: "Pick who it asks." } : {}),
    ...("problem" in schedule ? { schedule: schedule.problem } : {}),
  };
  const shown = (field: string) => tried ? problems[field] : undefined;
  const valid = "problem" in schedule ? undefined : schedule as Schedule;
  // What a new chat each run comes to.
  const often = draft.post === "new" && valid ? oftenPerDay(valid) : undefined;
  const named = draft.name.trim() || nameFrom(draft.text) || "Routine";
  const scheduleChanged = JSON.stringify(givenOf(picking)) !== JSON.stringify(givenOf(when));
  const changed: Record<string, unknown> = {
    ...(draft.name.trim() !== was.name.trim() && draft.name.trim()
      ? { name: draft.name.trim() }
      : {}),
    ...(draft.text.trim() !== was.text.trim() ? { text: draft.text.trim() } : {}),
    ...(draft.agent !== was.agent ? { agent: draft.agent } : {}),
    ...(draft.post !== was.post ? { post: draft.post } : {}),
    ...((draft.chatName ?? "").trim() !== (was.chatName ?? "").trim()
      ? { chatName: (draft.chatName ?? "").trim() }
      : {}),
    ...(scheduleChanged ? { schedule: givenOf(picking) } : {}),
  };

  const save = async () => {
    setTried(true);
    if (busy || Object.keys(problems).length) return;
    if (routine && !Object.keys(changed).length) return done(routine);
    setBusy(true);
    setError(undefined);
    try {
      const made = routine
        ? await call<{ routine: string }>("routine.update", { routine, ...changed })
        : await call<{ routine: string }>("routine.create", {
          in: space,
          ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
          text: draft.text.trim(),
          agent: draft.agent,
          schedule: givenOf(picking),
          post: draft.post,
          ...(draft.post === "new" && draft.chatName?.trim()
            ? { chatName: draft.chatName.trim() }
            : {}),
        });
      done(made.routine);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };

  return (
    <form
      className="routine-form"
      aria-label={fresh ? "A new routine" : `Change ${was.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="routine-field">
        <label className="routine-label" htmlFor={`${id}-text`}>What it asks</label>
        <Textarea
          id={`${id}-text`}
          autoGrow
          autoFocus={fresh}
          rows={2}
          maxLength={8000}
          value={draft.text}
          disabled={busy}
          placeholder="What's new in our market today? Three short bullets, with sources."
          aria-describedby={`${id}-text-note`}
          aria-invalid={shown("text") ? true : undefined}
          onChange={(event) => set({ text: event.target.value })}
        />
        <p id={`${id}-text-note`} className={shown("text") ? "routine-error" : "routine-note"}>
          {shown("text") ?? "Sent as you, each time it runs, to the agent you pick."}
        </p>
      </div>

      <div className="routine-field">
        <span className="routine-label" id={`${id}-agent`}>Who it asks</span>
        {agents.length
          ? (
            <div className="routine-agents" role="radiogroup" aria-labelledby={`${id}-agent`}>
              {agents.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="radio"
                  className="routine-agent"
                  aria-checked={draft.agent === a.id}
                  disabled={busy}
                  onClick={() => set({ agent: a.id })}
                >
                  <Avatar name={a.name} kind="agent" icon={a.icon} size={28} />
                  {a.name}
                  {a.name !== a.id ? <small>@{a.id}</small> : null}
                </button>
              ))}
            </div>
          )
          : <p className="routine-note">No agent answers in this space yet: add one first.</p>}
        {shown("agent") ? <p className="routine-error">{shown("agent")}</p> : null}
      </div>

      <SchedulePicker
        value={picking}
        disabled={busy}
        onChange={(patch) => setPicking((now) => ({ ...now, ...patch }))}
      />

      <div className="routine-field">
        <span className="routine-label" id={`${id}-post`}>Where it posts</span>
        <div className="routine-posts" role="radiogroup" aria-labelledby={`${id}-post`}>
          {([
            ["same", "Always the same chat", "Runs add to one chat, so it reads like a log."],
            [
              "new",
              "A new chat each run",
              "Each run is its own chat, to open and follow up later.",
            ],
          ] as const).map(([value, title, note]) => (
            <label key={value} className="routine-post">
              <input
                type="radio"
                name={`${id}-post`}
                value={value}
                checked={draft.post === value}
                disabled={busy}
                onChange={() => set({ post: value })}
              />
              <span>
                <b>{title}</b>
                <span>{note}</span>
              </span>
            </label>
          ))}
        </div>
        {often
          ? (
            <p className="routine-warning" role="status">
              That's about {often}{" "}
              new chats a day. For something this frequent, the same chat usually reads better.
            </p>
          )
          : null}
      </div>

      {draft.post === "new"
        ? (
          <div className="routine-field">
            <label className="routine-label" htmlFor={`${id}-chat`}>What each chat is called</label>
            <Input
              id={`${id}-chat`}
              value={draft.chatName ?? ""}
              maxLength={120}
              disabled={busy}
              placeholder={valid ? defaultChatName(valid) : "{name} · {date}"}
              aria-describedby={`${id}-chat-note`}
              onChange={(event) => set({ chatName: event.target.value })}
            />
            <p id={`${id}-chat-note`} className="routine-note">
              {"{date}, {time}, {run} and {name} are filled in each run"}
              {valid
                ? <>: “{chatTitle({ name: named, chatName: draft.chatName, schedule: valid })}”.</>
                : "."} The agent can rename it for what it found.
            </p>
          </div>
        )
        : null}

      <div className="routine-field">
        <label className="routine-label" htmlFor={`${id}-name`}>Name</label>
        <Input
          id={`${id}-name`}
          value={draft.name}
          maxLength={80}
          disabled={busy}
          placeholder={draft.text.trim() ? nameFrom(draft.text) : "Morning briefing"}
          onChange={(event) => set({ name: event.target.value })}
        />
        <p className="routine-note">How it's listed, and how its messages are marked.</p>
      </div>

      <div className="routine-form-end">
        {error
          ? <p className="routine-error" role="alert">{error}</p>
          : tried && Object.keys(problems).length
          ? <p className="routine-error" role="alert">{Object.values(problems)[0]}</p>
          : <p className="routine-note" aria-live="polite" />}
        {cancel ? <Button onClick={cancel} disabled={busy}>Cancel</Button> : null}
        <Button
          type="submit"
          variant="primary"
          icon={fresh ? "plus" : "check"}
          loading={busy}
          disabled={!fresh && !Object.keys(changed).length}
        >
          {fresh ? "Create routine" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
