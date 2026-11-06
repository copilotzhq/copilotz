/**
 * Making a developer key, in a dialog: a name to know it by, then what it
 * may use (its scope): a preset (the `apiPresets` resource: chatting,
 * reading), or a custom pick of the app's Actions (from its catalog, by
 * plugin) and queries (by name). What it may use says how it works in the
 * space (an editor when it calls Actions, else a viewer), said beside it.
 * Made, its secret shows once, with a copy button and what to paste in a
 * terminal to try it, the secret in it.
 */
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { Scope } from "../../../../../runtime/mod.ts";
import {
  appBase,
  Button,
  Checkbox,
  Chip,
  CodeBlock,
  Dialog,
  Field,
  Icon,
  Input,
  message,
  Notice,
  Skeleton,
} from "../../../../../hosts/web/mod.ts";
import { type ApiPreset, roleOf } from "../../contract.ts";
import { type ActionEntry, useCatalog } from "./catalog.ts";
import { KINDS, namesIn, snippets } from "./snippet.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export type Presets = [string, ApiPreset][];

const CUSTOM = "custom";

/** A custom pick, to start with: nothing. */
const NONE: Required<Pick<Scope, "call" | "query">> = { call: [], query: [] };

/** A scope with only the lists it has, as a key keeps it. */
const kept = (scope: Scope): Scope =>
  Object.fromEntries(KINDS.flatMap((kind) => scope[kind]?.length ? [[kind, scope[kind]]] : []));

export function CreateDialog(
  { open, onClose, space, where, presets, call }: {
    open: boolean;
    onClose(): void;
    space: string;
    /** The space, as the dialog says it. */
    where: string;
    presets: Presets;
    call: Call;
  },
): ReactNode {
  const [name, setName] = useState("");
  const [choice, setChoice] = useState(presets[0]?.[0] ?? CUSTOM);
  const [custom, setCustom] = useState(NONE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [made, setMade] = useState<{ key: string; scope: Scope }>();

  useEffect(() => {
    if (!open) return;
    setName("");
    setChoice(presets[0]?.[0] ?? CUSTOM);
    setCustom(NONE);
    setError(undefined);
    setMade(undefined);
  }, [open]);

  const scope = kept(
    choice === CUSTOM ? custom : presets.find(([key]) => key === choice)?.[1].scope ?? {},
  );
  const something = namesIn(scope).length > 0;
  const ready = !!name.trim() && something && !busy;

  const create = async () => {
    if (!ready) return;
    setBusy(true);
    setError(undefined);
    try {
      const { key } = await call<{ key: string }>("api_key.create", {
        in: space,
        name: name.trim(),
        scope,
      });
      setMade({ key, scope });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={made ? `“${name.trim()}” is ready` : "New developer key"}
      description={made
        ? undefined
        : `For code that calls the agents in ${where}. It acts as you, only there.`}
      footer={made ? <Button variant="primary" onClick={onClose}>Done</Button> : (
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon="lock"
            loading={busy}
            disabled={!ready}
            onClick={() => void create()}
          >
            Create key
          </Button>
        </>
      )}
    >
      {made ? <Made secret={made.key} scope={made.scope} space={space} /> : (
        <form
          className="api-form"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <Field label="Name" hint="So you know it again: what it's for, where it runs.">
            {(control) => (
              <Input
                {...control}
                value={name}
                maxLength={80}
                autoFocus
                autoComplete="off"
                placeholder="Support bot"
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <fieldset className="api-choice">
            <legend>What it can do</legend>
            <div className="api-presets" role="radiogroup" aria-label="What it can do">
              {presets.map(([key, preset]) => (
                <Choice
                  key={key}
                  checked={choice === key}
                  onSelect={() => setChoice(key)}
                  title={preset.title}
                  text={preset.description}
                  names={namesIn(preset.scope ?? {})}
                />
              ))}
              <Choice
                checked={choice === CUSTOM}
                onSelect={() => setChoice(CUSTOM)}
                title="Custom"
                text="Pick its Actions and queries one by one."
              />
            </div>
            {choice === CUSTOM
              ? <Custom value={custom} onChange={setCustom} presets={presets} />
              : null}
            {something ? <Role scope={scope} where={where} /> : null}
          </fieldset>
          {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
          {/* Enter in the name makes it. */}
          <button type="submit" hidden />
        </form>
      )}
    </Dialog>
  );
}

/** A preset, as a card to choose. */
function Choice(
  { checked, onSelect, title, text, names = [] }: {
    checked: boolean;
    onSelect(): void;
    title: string;
    text: string;
    names?: string[];
  },
): ReactNode {
  return (
    <label className="api-preset" data-checked={checked || undefined}>
      <input type="radio" name="api-preset" checked={checked} onChange={onSelect} />
      <span className="api-preset-title">
        {title}
        <span className="api-preset-check" aria-hidden="true">
          <Icon name="check" size={12} />
        </span>
      </span>
      <span className="api-preset-text">{text}</span>
      {names.length
        ? (
          <span className="api-preset-names">
            {names.map((n) => <span key={n} className="api-name">{n}</span>)}
          </span>
        )
        : null}
    </label>
  );
}

/** How a key with this scope works in the space: what its role lets, in a line. */
function Role({ scope, where }: { scope: Scope; where: string }): ReactNode {
  const editor = roleOf(scope) === "editor";
  return (
    <p className="api-role" data-role={editor ? "editor" : "viewer"}>
      <Icon name={editor ? "pencil" : "eye"} size={14} />
      <span>
        {editor
          ? (
            <>
              <b>Works as an editor</b> in {where}: it may change things, as far as you can.
            </>
          )
          : (
            <>
              <b>Works as a viewer</b> in {where}: it reads, and changes nothing.
            </>
          )}
      </span>
    </p>
  );
}

/** The plugin an Action is from, by its name: `chat.send` is chat's. */
const groupOf = (name: string) => name.split(".")[0];

/**
 * A custom pick: the app's Actions, by plugin, searchable, each with what
 * it does; and queries, by name (the presets' to start from, any other
 * typed in).
 */
function Custom(
  { value, onChange, presets }: {
    value: typeof NONE;
    onChange(value: typeof NONE): void;
    presets: Presets;
  },
): ReactNode {
  const catalog = useCatalog();
  const [search, setSearch] = useState("");
  const [typed, setTyped] = useState("");
  const toggle = (list: "call" | "query", name: string) =>
    onChange({
      ...value,
      [list]: value[list].includes(name)
        ? value[list].filter((n) => n !== name)
        : [...value[list], name],
    });
  const found = useMemo(() => {
    if (!Array.isArray(catalog)) return [];
    const words = search.trim().toLowerCase();
    return catalog.filter((a) =>
      !words || a.name.toLowerCase().includes(words) ||
      a.description?.toLowerCase().includes(words)
    );
  }, [catalog, search]);
  const groups = new Map<string, ActionEntry[]>();
  for (const action of found) {
    groups.set(groupOf(action.name), [...groups.get(groupOf(action.name)) ?? [], action]);
  }
  const known = [...new Set([...presets.flatMap(([, p]) => p.scope?.query ?? []), ...value.query])];
  const add = () => {
    const names = typed.split(/[\s,]+/).filter((n) => /^[\w.:-]+$/.test(n));
    if (names.length) {
      onChange({ ...value, query: [...new Set([...value.query, ...names])] });
    }
    setTyped("");
  };
  return (
    <div className="api-custom">
      <div className="api-pick">
        <div className="api-custom-head">
          <h4>Actions</h4>
          <span className="api-custom-count">{value.call.length} picked</span>
        </div>
        {catalog === "unavailable"
          ? (
            <Input
              placeholder="chat.send, chat.stop"
              aria-label="Actions, by name"
              value={value.call.join(", ")}
              onChange={(event) =>
                onChange({
                  ...value,
                  call: event.target.value.split(/[\s,]+/).filter(Boolean),
                })}
            />
          )
          : (
            <>
              <Input
                icon="search"
                size="sm"
                placeholder="Find an Action"
                aria-label="Find an Action"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <div className="api-pick-list" role="group" aria-label="Actions">
                {catalog === "loading"
                  ? [0, 1, 2].map((i) => <Skeleton key={i} height={30} />)
                  : [...groups].map(([group, actions]) => (
                    <div key={group}>
                      <p className="api-pick-group">{group}</p>
                      {actions.map((action) => (
                        <div className="api-pick-item" key={action.name}>
                          <Checkbox
                            checked={value.call.includes(action.name)}
                            onChange={() => toggle("call", action.name)}
                            label={
                              <span className="api-pick-label">
                                <code>{action.name}</code>
                                {action.description ? <span>{action.description}</span> : null}
                              </span>
                            }
                          />
                        </div>
                      ))}
                    </div>
                  ))}
                {Array.isArray(catalog) && !found.length
                  ? <p className="api-pick-group">Nothing matches</p>
                  : null}
              </div>
            </>
          )}
      </div>
      <div className="api-pick">
        <div className="api-custom-head">
          <h4>Queries</h4>
          <span className="api-custom-count">{value.query.length} picked</span>
        </div>
        <div className="api-chips">
          {known.map((name) => (
            <Chip
              key={name}
              size="sm"
              variant={value.query.includes(name) ? "primary" : "outline"}
              icon={value.query.includes(name) ? "check" : "plus"}
              title={value.query.includes(name) ? `Leave out ${name}` : `Let it run ${name}`}
              onClick={() => toggle("query", name)}
            >
              {name}
            </Chip>
          ))}
        </div>
        <Input
          size="sm"
          placeholder="Another, by name: note.list"
          aria-label="Add a query by name"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            add();
          }}
          end={typed.trim() ? <Button size="sm" variant="ghost" onClick={add}>Add</Button> : null}
        />
      </div>
    </div>
  );
}

/** The key, once: copy it, and try it. */
function Made(
  { secret, scope, space }: { secret: string; scope: Scope; space: string },
): ReactNode {
  const origin = appBase();
  return (
    <div className="api-made">
      <Notice tone="warning" icon="lock" title="Copy your key now">
        You won't see it again: only its first characters are kept, to tell it apart. Keep it where
        your code reads secrets, never in the code itself.
      </Notice>
      <CodeBlock
        className="api-secret"
        label="Your new key"
        code={[{ text: secret, tone: "accent" }]}
        copy={secret}
      />
      <h3 className="api-sub">Try it</h3>
      {snippets(origin, scope, { secret, space }).map((s) => (
        <CodeBlock key={s.title} title={s.title} code={s.code} copy={s.text} />
      ))}
      <p className="api-note">
        Its reference, with each Action's input, is at <code>{origin}/api/</code> with the key.
      </p>
    </div>
  );
}
