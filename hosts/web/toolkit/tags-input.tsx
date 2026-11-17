/**
 * A field of tags: each value a tag with its remove button, then a place to
 * type the next. Enter or a comma adds what's typed, Backspace in the empty
 * place removes the last tag, pasting "a, b, c" adds three, and leaving the
 * field adds what's left in it; a tag already there isn't added twice.
 * Named by `label` (or by a `<label>` for its `id`, the typing place's).
 *
 * ```tsx
 * <TagsInput id="formats" label="Input formats" values={formats} onChange={setFormats} />
 * ```
 */
import { type ReactNode, useRef, useState } from "react";
import { cx } from "./cx.ts";
import { Icon } from "./icon.tsx";
import { sheet } from "./sheet.tsx";
import { withTags } from "./tags.ts";
import { say } from "./words.ts";

const SHEET = sheet(
  "tags-input",
  `
.copilotz-tags-input { display: flex; flex-wrap: wrap; align-items: center; gap: var(--tags-input-gap, 6px);
  box-sizing: border-box; min-height: var(--tags-input-min-height, var(--input-height, 40px)); padding: var(--tags-input-padding, 5px 8px);
  border: var(--tags-input-border-width, var(--input-border-width, 1px)) solid var(--tags-input-border-color, var(--input));
  border-radius: var(--tags-input-radius, var(--input-radius, var(--radius-lg))); background: var(--tags-input-background, var(--input-background, var(--card)));
  color: var(--foreground); font-size: var(--tags-input-font-size, var(--input-font-size, 14.5px)); line-height: 1.4; cursor: text;
  transition: border-color .15s, box-shadow .15s; }
.copilotz-tags-input:focus-within { border-color: var(--tags-input-focus-border-color, var(--ring));
  box-shadow: var(--tags-input-focus-shadow,
    var(--input-focus-shadow, 0 0 0 4px color-mix(in oklab, var(--ring) 16%, transparent))); }
.copilotz-tags-input[data-disabled] { opacity: .55; cursor: default; }
.copilotz-tags-input > input { flex: 1; min-width: 6em; height: 26px; margin: 0; padding: 0; border: 0; outline: 0;
  background: transparent; color: inherit; font: inherit; }
.copilotz-tag { display: inline-flex; align-items: center; gap: 3px; max-width: 100%;
  padding: var(--tag-padding, 2px 4px 2px 9px); border-radius: var(--tag-radius, var(--radius-full));
  background: var(--tag-background, var(--secondary)); color: var(--tag-foreground, var(--secondary-foreground));
  font-size: var(--tag-font-size, 13px); font-weight: var(--tag-font-weight, 560); line-height: 1.4; }
.copilotz-tag > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.copilotz-tag > button { display: grid; place-items: center; flex: none; width: 18px; height: 18px; padding: 0; border: 0;
  border-radius: var(--radius-full); background: transparent; color: inherit; opacity: .7; cursor: pointer; }
.copilotz-tag > button:hover { opacity: 1; }
@media (pointer: coarse) {
  .copilotz-tags-input { min-height: 44px; }
  .copilotz-tag > button { width: 28px; height: 28px; margin: -5px -4px -5px 0; }
}
`,
);

export function TagsInput(
  { values, onChange, label, id, name, placeholder, disabled, className }: {
    values: string[];
    onChange(values: string[]): void;
    /** What the field is, said to screen readers, when no `<label>` names it. */
    label?: string;
    /** The typing place's id, for a `<label htmlFor>`. */
    id?: string;
    /** Sends the tags with a form, one comma-separated value under this name. */
    name?: string;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
  },
): ReactNode {
  const [text, setText] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const add = (typed: string) => {
    const next = withTags(values, typed);
    if (next.length !== values.length) onChange(next);
    setText("");
  };
  return (
    <div
      className={cx("copilotz-tags-input", className)}
      data-disabled={disabled || undefined}
      onMouseDown={(event) => {
        // A press on the box, not on a tag, types into it.
        if (event.target !== event.currentTarget || disabled) return;
        event.preventDefault();
        field.current?.focus();
      }}
    >
      {SHEET}
      {values.map((tag) => (
        <span key={tag} className="copilotz-tag">
          <span>{tag}</span>
          <button
            type="button"
            aria-label={say("removeTag", { tag })}
            disabled={disabled}
            onClick={() => {
              onChange(values.filter((value) => value !== tag));
              field.current?.focus();
            }}
          >
            <Icon name="close" size={12} />
          </button>
        </span>
      ))}
      <input
        ref={field}
        id={id}
        type="text"
        aria-label={label}
        placeholder={values.length ? undefined : placeholder}
        value={text}
        disabled={disabled}
        enterKeyHint="enter"
        onChange={(event) => {
          const typed = event.target.value;
          if (/[,\n]/.test(typed)) add(typed);
          else setText(typed);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            // Enter adds a tag; with nothing typed, it goes on to the form.
            if (!text.trim()) return;
            event.preventDefault();
            add(text);
          } else if (event.key === "Backspace" && text === "" && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData("text");
          if (!/[,\n]/.test(pasted)) return;
          event.preventDefault();
          add(text + pasted);
        }}
        onBlur={() => {
          if (text.trim()) add(text);
        }}
      />
      {name ? <input type="hidden" name={name} value={values.join(",")} /> : null}
    </div>
  );
}
