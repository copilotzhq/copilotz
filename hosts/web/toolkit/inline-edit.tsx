/**
 * A name changed where it shows (a page's title): a field with what it says
 * now, selected; Enter or the check saves it (`save`, which may fail: the
 * field then says why and stays), Escape or the cross leaves it as it was.
 * Either way `done` follows. Unchanged or empty, there's nothing to save.
 *
 * ```tsx
 * {renaming
 *   ? <InlineEdit label="The space's name" value={name} save={rename} done={() => setRenaming(false)} />
 *   : name}
 * ```
 */
import { type ReactNode, useState } from "react";
import { cx } from "./cx.ts";
import { IconButton } from "./icon-button.tsx";
import { Input } from "./input.tsx";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "inline-edit",
  `
.copilotz-inline-edit { display: grid; gap: 4px; width: min(100%, 440px); }
.copilotz-inline-edit-error { margin: 0; color: var(--destructive-text); font-size: 12.5px; font-weight: 450;
  letter-spacing: 0; }
`,
);

/** Why saving failed, in words. */
const why = (error: unknown) =>
  error instanceof Error
    ? error.message
    : String((error as { message?: unknown } | null)?.message ?? error);

export function InlineEdit(
  { value, label, save, done, maxLength = 64, size = "md", className }: {
    value: string;
    /** What it is, said to screen readers: "The space's name". */
    label: string;
    save(value: string): Promise<unknown>;
    done(): void;
    maxLength?: number;
    size?: "sm" | "md" | "lg";
    className?: string;
  },
): ReactNode {
  const [text, setText] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    const next = text.trim();
    if (!next || next === value) return done();
    setBusy(true);
    setError(undefined);
    try {
      await save(next);
      done();
    } catch (e) {
      setError(why(e));
      setBusy(false);
    }
  };
  return (
    <span className={cx("copilotz-inline-edit", className)}>
      {SHEET}
      <Input
        aria-label={label}
        value={text}
        size={size}
        maxLength={maxLength}
        autoFocus
        autoComplete="off"
        invalid={!!error}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            done();
          }
        }}
        end={
          <>
            <IconButton
              icon="check"
              label="Save"
              size="sm"
              loading={busy}
              disabled={!text.trim()}
              onClick={() => void submit()}
            />
            <IconButton icon="close" label="Cancel" size="sm" onClick={done} />
          </>
        }
      />
      {error ? <span role="alert" className="copilotz-inline-edit-error">{error}</span> : null}
    </span>
  );
}
