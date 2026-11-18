/**
 * The first step of making an agent: what it should do, in a sentence or two,
 * and Draft it (`agent.sketch`: its name, emoji, what it does, instructions
 * and kind of work, a moment on a real model, said so while it writes). Or
 * fill it in by hand. And the kind-of-work field the form shows where tiers
 * give agents their models.
 */
import { type ReactNode, useState } from "react";
import { Button, Field, message, Notice, Select, Spinner, Textarea } from "copilotz/web";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** A kind of work, as tiers name it, with the app's agents that do it. */
export type KindOption = { kind: string; title: string; agents?: string[] };

/** What `agent.sketch` drafts. */
export type Sketch = {
  name: string;
  icon: string;
  description: string;
  instructions: string;
  like?: string;
};

export function Describe(
  { kinds, call, onDraft, onSkip, placeholder }: {
    kinds?: KindOption[];
    call: Call;
    onDraft(sketch: Sketch): void;
    onSkip(): void;
    placeholder?: string;
  },
): ReactNode {
  const [asked, setAsked] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const draft = async () => {
    if (asked.trim().length < 3 || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      onDraft(
        await call<Sketch>("agent.sketch", {
          asked: asked.trim(),
          ...(kinds?.length ? { kinds } : {}),
        }),
      );
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  return (
    <div className="agent-describe">
      <Field label={say("fieldDoes")} hint={say("describeHint")}>
        {(control) => (
          <Textarea
            {...control}
            value={asked}
            rows={3}
            autoGrow
            autoFocus
            disabled={busy}
            maxLength={1000}
            placeholder={placeholder ?? say("describePlaceholder")}
            onChange={(e) => setAsked(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void draft();
            }}
          />
        )}
      </Field>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      <div className="agent-describe-end">
        <Button variant="ghost" size="sm" onClick={onSkip} disabled={busy}>
          {say("fillMyself")}
        </Button>
        <Button
          variant="primary"
          icon={busy ? undefined : "sparkles"}
          disabled={asked.trim().length < 3}
          loading={busy}
          onClick={() => void draft()}
        >
          {busy ? say("drafting") : say("draftIt")}
        </Button>
      </div>
      {busy
        ? (
          <p className="agent-describe-wait" aria-live="polite">
            <Spinner size={12} /> {say("draftingWait")}
          </p>
        )
        : null}
    </div>
  );
}

/** The kind of work an agent does, where tiers give agents their models: in place of a model. */
export function KindField(
  { kinds, value, onChange, disabled }: {
    kinds: KindOption[];
    value: string;
    onChange(kind: string): void;
    disabled?: boolean;
  },
): ReactNode {
  return (
    <Field label={say("kindLabel")} hint={say("kindHint")}>
      {(control) => (
        <Select
          {...control}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          {kinds.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.agents?.length
                ? say("kindLike", { kind: k.title, agents: k.agents.join(", ") })
                : k.title}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}
