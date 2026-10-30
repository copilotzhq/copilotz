/**
 * Making an agent in a space, for those who manage it: one calm form (its
 * fields: `AgentFields`), what it may start from (one of the app's agents,
 * `from`: its words, model and tools filled in), and the role it works in
 * there. Made (`agent.create` there, then `member.set`), it says so, with
 * what's next: have it answer new chats, open its page, or make another.
 */
import { type MouseEvent, type ReactNode, useId, useState } from "react";
import { Avatar, Button, Field, Icon, message, Select } from "../../../../../hosts/web/mod.ts";
import { AGENT_ROLES } from "../../../../access/spaces/contract.ts";
import type { Agent } from "../../../chat/contract.ts";
import { AgentFields, type Draft } from "./agent-fields.tsx";
import { agentPath, handleOf, type Options, shownAs, usualTools } from "./agents.ts";
import { type Place, placeName } from "./places.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** What was made: its id, how it shows, and its role here. */
type MadeAgent = { id: string; name: string; icon?: string; role: string };

/** A link in a dialog closes it as it's followed: the page it opens is behind. */
const leaving = (event: MouseEvent<HTMLElement>) => event.currentTarget.closest("dialog")?.close();

export function NewAgent(
  { space, known, options, call, from: first, onBack }: {
    space: Place;
    /** Every agent the person has met: the app's, to start from; and names taken. */
    known: Record<string, Agent>;
    options: Options;
    call: Call;
    /** One of the app's agents to start from. */
    from?: string;
    /** Back to the agents they know, when there are some to add. */
    onBack?(): void;
  },
): ReactNode {
  const id = useId();
  const offered = options.tools.map((t) => t.name);
  const app = Object.entries(known).filter(([, agent]) => !agent.in);
  const blank = (): Draft => ({
    name: "",
    icon: "",
    description: "",
    instructions: "",
    model: options.models[0] ?? "",
    tools: usualTools(known, offered),
  });
  const like = (base: string): Draft => {
    const agent = known[base];
    const model = typeof agent.model === "string" ? agent.model : undefined;
    return {
      name: "",
      icon: agent.icon ?? "",
      description: agent.description ?? "",
      instructions: agent.instructions,
      model: model && options.models.includes(model) ? model : options.models[0] ?? "",
      tools: (agent.tools ?? []).filter((tool) => offered.includes(tool)),
    };
  };
  const [from, setFrom] = useState(first && known[first] && !known[first].in ? first : "");
  const [draft, setDraft] = useState<Draft>(() => from ? like(from) : blank());
  const [role, setRole] = useState("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [made, setMade] = useState<MadeAgent>();
  const name = draft.name.trim();
  const handle = name ? handleOf(name, (taken) => taken in known) : "";
  const where = placeName(space);

  if (made) {
    return (
      <Done
        made={made}
        space={space}
        call={call}
        again={() => {
          setMade(undefined);
          setFrom("");
          setDraft(blank());
        }}
      />
    );
  }

  return (
    <form
      className="agent-new"
      aria-label="A new agent"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!name || !draft.model || busy) return;
        setBusy(true);
        setError(undefined);
        try {
          const { agent } = await call<{ agent: string }>("agent.create", {
            in: space._id,
            name,
            ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
            ...(draft.instructions.trim() ? { instructions: draft.instructions.trim() } : {}),
            model: draft.model,
            tools: draft.tools,
            ...(draft.icon ? { icon: draft.icon } : {}),
            ...(from ? { from } : {}),
          });
          await call("member.set", {
            space: space._id,
            member: { kind: "agent", id: agent },
            role,
          });
          setMade({ id: agent, ...shownAs(agent, { name, icon: draft.icon || undefined }), role });
        } catch (e) {
          setError(message(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {onBack || app.length
        ? (
          <div className="agent-new-top">
            {onBack
              ? (
                <Button size="sm" variant="ghost" icon="chevron-left" onClick={onBack}>
                  Agents you know
                </Button>
              )
              : <span />}
            {app.length
              ? (
                <label className="agent-new-from">
                  <span>Start from</span>
                  <Select
                    size="sm"
                    value={from}
                    onChange={(event) => {
                      const next = event.target.value;
                      setFrom(next);
                      setDraft((now) => ({ ...(next ? like(next) : blank()), name: now.name }));
                    }}
                  >
                    <option value="">Nothing: a blank agent</option>
                    {app.map(([key, agent]) => (
                      <option key={key} value={key}>{shownAs(key, agent).name}</option>
                    ))}
                  </Select>
                </label>
              )
              : null}
          </div>
        )
        : null}
      <AgentFields
        value={draft}
        onChange={(patch) => setDraft((now) => ({ ...now, ...patch }))}
        options={options}
        handle={handle}
        call={call}
        autoFocus
      />
      <Field
        label={`Works in ${where} as`}
        hint={`${AGENT_ROLES.find((r) => r.value === role)?.lets}. It belongs to ${where}: ` +
          "those who manage it change it."}
      >
        {(control) => (
          <Select
            {...control}
            value={role}
            onChange={(event) => setRole(event.target.value)}
          >
            {AGENT_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </Select>
        )}
      </Field>
      <div className="agent-new-end">
        <p id={`${id}-said`} className="agent-form-note" aria-live="polite">
          {error ? <span className="agent-error" role="alert">{error}</span> : null}
        </p>
        <Button
          type="submit"
          variant="primary"
          icon="plus"
          loading={busy}
          disabled={!name || !draft.model}
          aria-describedby={`${id}-said`}
        >
          {name ? `Create ${name}` : "Create agent"}
        </Button>
      </div>
    </form>
  );
}

/** Made: what it is now, and what's next. */
function Done(
  { made, space, call, again }: { made: MadeAgent; space: Place; call: Call; again(): void },
): ReactNode {
  const [answers, setAnswers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const where = placeName(space);
  return (
    <div className="agent-made" role="status">
      <span className="agent-made-face">
        <Avatar name={made.name} kind="agent" icon={made.icon} size={48} />
        <span className="agent-made-check">
          <Icon name="check" size={12} />
        </span>
      </span>
      <div className="agent-made-text">
        <h3>{made.name} works in {where} now</h3>
        <p>
          {error ?? (made.role === "editor"
            ? (
              <>
                Ask <b className="agent-handle">@{made.id}</b> in any chat here.
              </>
            )
            : "It reads what's here for chats where it's an editor; it doesn't answer here.")}
        </p>
        <div className="agent-made-actions">
          {made.role === "editor"
            ? (
              <Button
                size="sm"
                icon={answers ? "check" : "chat"}
                loading={busy}
                disabled={answers}
                onClick={async () => {
                  setBusy(true);
                  setError(undefined);
                  try {
                    await call("space.agent", { space: space._id, agent: made.id });
                    setAnswers(true);
                  } catch (e) {
                    setError(message(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {answers ? "Answers new chats" : "Make it answer new chats"}
              </Button>
            )
            : null}
          <Button size="sm" href={agentPath(made.id)} onClick={leaving}>
            Open its page
          </Button>
          <Button size="sm" variant="ghost" icon="plus" onClick={again}>Make another</Button>
        </div>
      </div>
    </div>
  );
}
