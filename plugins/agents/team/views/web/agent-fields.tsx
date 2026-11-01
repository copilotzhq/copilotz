/**
 * What an agent is, as a form: its emoji and name (and what it's called by,
 * `@maya`), what it does, its instructions (written for the person from the
 * two with `agent.draft` if they like: a moment on a real model, said so
 * while it writes, and undone with a press), the model it thinks with, and
 * the tools it may use (those it has, in a line; all of them to tick, on a
 * press). Making an agent (`NewAgent`) and changing one (its page) show it;
 * what's typed goes up as it changes (`onChange`, a patch).
 */
import { type ReactNode, useId, useState } from "react";
import {
  Avatar,
  Button,
  Checkbox,
  Field,
  Icon,
  Input,
  message,
  Skeleton,
  Spinner,
  Textarea,
} from "../../../../../hosts/web/mod.ts";
import { ICONS, type Options } from "./agents.ts";
import { ModelPicker } from "./model-picker.tsx";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** An agent being made or changed: its fields, as typed. */
export type Draft = {
  name: string;
  icon: string;
  description: string;
  instructions: string;
  model: string;
  tools: string[];
};

/** How many tools the line shows before it counts the rest. */
const LINE = 6;

export function AgentFields(
  { value, onChange, options, handle, call, autoFocus, disabled }: {
    value: Draft;
    /** What changed: the form merges it into what's there. */
    onChange(patch: Partial<Draft>): void;
    options: Options;
    /** What it's called by: its id, or what a new one will be (none until it's named). */
    handle: string;
    call: Call;
    autoFocus?: boolean;
    disabled?: boolean;
  },
): ReactNode {
  const id = useId();
  const own = !!value.icon && !ICONS.includes(value.icon);
  return (
    <div className="agent-form">
      <div className="agent-form-who">
        {value.name.trim() || value.icon
          ? <Avatar name={value.name.trim() || "?"} kind="agent" icon={value.icon} size={56} />
          : (
            <span className="agent-face-empty" aria-hidden="true">
              <Icon name="bot" size={24} />
            </span>
          )}
        <Field
          label="Name"
          className="agent-form-name"
          hint={handle
            ? (
              <>
                Called <b className="agent-handle">@{handle}</b> in chats
              </>
            )
            : "What people call it: Maya is @maya in chats."}
        >
          {(control) => (
            <Input
              {...control}
              value={value.name}
              maxLength={60}
              placeholder="Maya"
              autoComplete="off"
              autoFocus={autoFocus}
              disabled={disabled}
              onChange={(event) => onChange({ name: event.target.value })}
            />
          )}
        </Field>
      </div>
      <div className="agent-form-field" role="radiogroup" aria-labelledby={`${id}-icon`}>
        <span id={`${id}-icon`} className="agent-form-label">Emoji</span>
        <div className="agent-icons">
          <button
            type="button"
            role="radio"
            aria-checked={!value.icon}
            aria-label="None: its initial"
            title="None: its initial"
            className="agent-icon agent-icon-none"
            disabled={disabled}
            onClick={() => onChange({ icon: "" })}
          >
            {(value.name.trim()[0] ?? "A").toUpperCase()}
          </button>
          {ICONS.map((icon) => (
            <button
              key={icon}
              type="button"
              role="radio"
              aria-checked={value.icon === icon}
              className="agent-icon"
              disabled={disabled}
              onClick={() => onChange({ icon })}
            >
              {icon}
            </button>
          ))}
          <Input
            size="sm"
            className="agent-icon-own"
            aria-label="Another emoji"
            placeholder="Other"
            value={own ? value.icon : ""}
            maxLength={16}
            autoComplete="off"
            disabled={disabled}
            data-chosen={own || undefined}
            onChange={(event) => onChange({ icon: event.target.value.trim() })}
          />
        </div>
      </div>
      <Field
        label="What should it do?"
        hint="A line or two, for people, and for other agents deciding whom to ask."
      >
        {(control) => (
          <Textarea
            {...control}
            rows={2}
            autoGrow
            maxHeight={160}
            maxLength={500}
            value={value.description}
            placeholder="Writes launch copy in our voice, and checks facts with the researcher."
            disabled={disabled}
            onChange={(event) => onChange({ description: event.target.value })}
          />
        )}
      </Field>
      <Instructions value={value} onChange={onChange} call={call} disabled={disabled} />
      <Field label="Model" hint="What it thinks with.">
        {(control) => (
          <ModelPicker
            id={control.id}
            value={value.model}
            call={call}
            disabled={disabled}
            onChange={(model) => onChange({ model })}
          />
        )}
      </Field>
      <Tools value={value.tools} onChange={(tools) => onChange({ tools })} options={options} />
    </div>
  );
}

/**
 * Its instructions: typed, or written for the person from its name and
 * what it should do (`agent.draft`), which takes a moment on a real model:
 * the box says so while it writes, and what it replaced comes back with Undo.
 */
function Instructions(
  { value, onChange, call, disabled }: {
    value: Draft;
    onChange(patch: Partial<Draft>): void;
    call: Call;
    disabled?: boolean;
  },
): ReactNode {
  const id = useId();
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string>();
  const [before, setBefore] = useState<string>();
  const name = value.name.trim();
  const ready = !!name && !!value.description.trim();
  const draft = async () => {
    setDrafting(true);
    setError(undefined);
    try {
      const { instructions } = await call<{ instructions: string }>("agent.draft", {
        name,
        description: value.description.trim(),
        ...(value.model ? { model: value.model } : {}),
      });
      setBefore(value.instructions);
      onChange({ instructions });
    } catch (e) {
      setError(message(e));
    } finally {
      setDrafting(false);
    }
  };
  return (
    <div className="agent-form-field">
      <div className="agent-form-label-row">
        <label className="agent-form-label" htmlFor={id}>Instructions</label>
        <Button
          size="sm"
          variant="ghost"
          icon="sparkles"
          className="agent-draft"
          loading={drafting}
          disabled={!ready || disabled}
          title={ready ? undefined : "Say its name and what it should do first"}
          onClick={() => void draft()}
        >
          {value.instructions.trim() ? "Rewrite them for me" : "Write them for me"}
        </Button>
      </div>
      <div className="agent-instructions" data-busy={drafting || undefined}>
        <Textarea
          id={id}
          rows={6}
          autoGrow
          maxHeight={420}
          maxLength={20_000}
          value={value.instructions}
          readOnly={drafting}
          disabled={disabled}
          aria-describedby={`${id}-note`}
          aria-busy={drafting || undefined}
          placeholder={`You are ${name || "Maya"}. You…`}
          onChange={(event) => {
            setBefore(undefined);
            onChange({ instructions: event.target.value });
          }}
        />
        {drafting
          ? (
            <div className="agent-drafting" role="status">
              <span className="agent-drafting-say">
                <Spinner size={13} />
                Writing {name}'s instructions…
              </span>
              {[92, 84, 96, 70, 88, 52].map((width, i) => (
                <Skeleton key={i} height={11} width={`${width}%`} />
              ))}
            </div>
          )
          : null}
      </div>
      <p id={`${id}-note`} className="agent-form-note">
        {error ? <span className="agent-error" role="alert">{error}</span> : before !== undefined
          ? (
            <>
              Written for you from what it should do: read them through, and change what you like.
              {" "}
              <Button
                variant="link"
                size="sm"
                className="agent-undo"
                onClick={() => {
                  onChange({ instructions: before });
                  setBefore(undefined);
                }}
              >
                Undo
              </Button>
            </>
          )
          : ready || value.instructions.trim()
          ? "What it's told every time it works: who it is, what it does, and how it answers."
          : "Say its name and what it should do, and it can write them for you."}
      </p>
    </div>
  );
}

/** The tools it may use: those it has, in a line; all of them to tick, once opened. */
function Tools(
  { value, onChange, options }: {
    value: string[];
    onChange(tools: string[]): void;
    options: Options;
  },
): ReactNode {
  const id = useId();
  const [open, setOpen] = useState(false);
  const offered = options.tools.map((t) => t.name);
  const chosen = offered.filter((name) => value.includes(name));
  const toggle = (name: string, on: boolean) =>
    onChange(on ? [...new Set([...value, name])] : value.filter((t) => t !== name));
  return (
    <div className="agent-form-field" role="group" aria-labelledby={`${id}-tools`}>
      <div className="agent-form-label-row">
        <span id={`${id}-tools`} className="agent-form-label">
          Tools <span className="agent-form-count">{chosen.length} of {offered.length}</span>
        </span>
        <Button
          size="sm"
          variant="ghost"
          iconEnd={open ? undefined : "chevron-down"}
          aria-expanded={open}
          aria-controls={`${id}-list`}
          onClick={() => setOpen(!open)}
        >
          {open ? "Done" : "Choose"}
        </Button>
      </div>
      {open
        ? (
          <div id={`${id}-list`} className="agent-tools">
            <div className="agent-tools-all">
              <Button size="sm" variant="link" onClick={() => onChange(offered)}>All</Button>
              <Button size="sm" variant="link" onClick={() => onChange([])}>None</Button>
            </div>
            <ul>
              {options.tools.map((t) => (
                <li key={t.name}>
                  <Checkbox
                    checked={value.includes(t.name)}
                    onChange={(event) => toggle(t.name, event.target.checked)}
                    label={
                      <span className="agent-tool">
                        <code>{t.name}</code>
                        <span>{t.description}</span>
                      </span>
                    }
                  />
                </li>
              ))}
            </ul>
          </div>
        )
        : (
          <p id={`${id}-list`} className="agent-tools-line">
            {chosen.length
              ? (
                <>
                  {chosen.slice(0, LINE).map((name) => <code key={name}>{name}</code>)}
                  {chosen.length > LINE ? <span>+{chosen.length - LINE} more</span> : null}
                </>
              )
              : <span>None: it only talks.</span>}
          </p>
        )}
    </div>
  );
}
