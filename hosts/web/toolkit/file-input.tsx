/**
 * A file to send, or several. It's the browser's own file field, so a form
 * sends what's chosen (`name`, `accept`, `multiple`, `required`), drawn as
 * a field of the toolkit's: a button that chooses ("Choose a file", or
 * "Change" once one is), what's chosen (the file's name and size, or how
 * many), and Remove. Files dropped on it are chosen too, those its `accept`
 * takes (only the first, unless `multiple`); while they're over it, it says
 * "Drop files here". `onChange` hears the files each time they change. `id`
 * is its button's, so a `Field`'s label (`htmlFor`) names it.
 *
 * Words are the app's (`toolkit.chooseFile`…), or each field's own: `chooseLabel`,
 * `changeLabel` and `removeLabel` ("Select image", "Change image", "Remove
 * image"). A file already stored is `current` (its name, or its URL, whose last
 * part is shown): with nothing new chosen the field shows it, its button says
 * "Change", and Remove (given `onRemove`) tells the app to drop it; removing a
 * new choice brings the stored file back.
 *
 * In a narrow column (a phone, a table's cell) it wraps: the name takes a
 * line of its own, cut short with an ellipsis, and the buttons' words wrap
 * rather than run past the field.
 *
 * Its look is the input's (`--input-*`: its height, border, radius,
 * background), and `--file-input-*` for its own: the choose button, and
 * the field while files are dragged over it.
 *
 * ```tsx
 * <Field label="Customers (CSV)" htmlFor="import" hint="One customer a line.">
 *   <FileInput id="import" name="file" accept=".csv,text/csv" onChange={([file]) => setFile(file)} />
 * </Field>
 * ```
 */
import { type DragEvent, type ReactNode, useId, useRef, useState } from "react";
import { bytes } from "./bytes.ts";
import { cx } from "./cx.ts";
import { keptOf } from "./files.ts";
import { Icon } from "./icon.tsx";
import { sheet } from "./sheet.tsx";
import { say } from "./words.ts";

const SHEET = sheet(
  "file-input",
  `
.copilotz-file-input { position: relative; display: flex; flex-wrap: wrap; align-items: center; gap: var(--file-input-gap, 10px);
  min-width: 0; min-height: var(--input-height, 40px); padding: var(--file-input-padding, 4px 6px 4px 4px);
  border: var(--input-border-width, 1px) dashed var(--input); border-radius: var(--input-radius, var(--radius-lg));
  background: var(--input-background, var(--card)); color: var(--foreground);
  font-size: var(--file-input-font-size, 14px); transition: border-color .15s, background-color .15s, box-shadow .15s; }
.copilotz-file-input:focus-within { border-color: var(--ring);
  box-shadow: var(--input-focus-shadow, 0 0 0 4px color-mix(in oklab, var(--ring) 16%, transparent)); }
.copilotz-file-input[data-chosen] { border-style: solid; }
.copilotz-file-input[data-dragging] { border-style: dashed;
  border-color: var(--file-input-drop-border-color, var(--primary));
  background: var(--file-input-drop-background, var(--primary-soft)); }
.copilotz-file-input[data-disabled] { opacity: .55; }
.copilotz-file-input-native { position: absolute; inset: auto auto 0 0; width: 1px; height: 1px; margin: 0;
  padding: 0; border: 0; opacity: 0; pointer-events: none; }
.copilotz-file-input-choose { display: inline-flex; flex: none; align-items: center; gap: 6px; max-width: 100%;
  min-height: var(--file-input-button-height, 30px); margin: 0; padding: var(--file-input-button-padding, 0 11px);
  border: 0; border-radius: var(--file-input-button-radius, var(--radius-md));
  background: var(--file-input-button-background, var(--secondary));
  color: var(--file-input-button-foreground, var(--secondary-foreground)); font: inherit; font-size: 13px;
  font-weight: var(--file-input-button-font-weight, 560); text-align: start; overflow-wrap: anywhere;
  cursor: pointer; }
.copilotz-file-input-choose:hover:not(:disabled) { background: var(--accent); color: var(--accent-foreground); }
.copilotz-file-input-choose:disabled { cursor: default; }
.copilotz-file-input-text { flex: 1 1 6em; min-width: 0; overflow: hidden; color: var(--muted-foreground);
  text-overflow: ellipsis; white-space: nowrap; }
.copilotz-file-input[data-chosen] .copilotz-file-input-text { color: var(--foreground); }
.copilotz-file-input-size { margin-inline-start: 6px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.copilotz-file-input-remove { flex: none; max-width: 100%; min-height: var(--file-input-button-height, 30px);
  margin: 0; margin-inline-start: auto; padding: 0 8px; overflow-wrap: anywhere; border: 0;
  border-radius: var(--file-input-button-radius, var(--radius-md)); background: transparent;
  color: var(--muted-foreground); font: inherit; font-size: 13px; font-weight: 560; cursor: pointer; }
.copilotz-file-input-remove:hover { background: var(--accent); color: var(--accent-foreground); }
@media (pointer: coarse) {
  .copilotz-file-input-choose, .copilotz-file-input-remove { min-height: 40px; }
}
`,
);

/** A stored file's name: the last part of its path, without query or fragment. */
const nameOfStored = (current: string): string => {
  const last = current.split(/[?#]/)[0].split("/").filter(Boolean).pop() ?? current;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

/** Whether a drag carries files (not text, not a link). */
const carriesFiles = (event: DragEvent) => [...event.dataTransfer.types].includes("Files");

export function FileInput(
  {
    id,
    name,
    accept,
    multiple,
    required,
    disabled,
    placeholder,
    label,
    chooseLabel,
    changeLabel,
    removeLabel,
    current,
    onRemove,
    onChange,
    className,
  }: {
    /** Its button's id: a `Field`'s label (`htmlFor`) names it. */
    id?: string;
    /** Sends the chosen files with a form, under this name. */
    name?: string;
    /** The files it takes, as the browser's file field reads it: `.csv,text/csv`, `image/*`. */
    accept?: string;
    multiple?: boolean;
    /** A form isn't sent without a file. */
    required?: boolean;
    disabled?: boolean;
    /** What it says with nothing chosen (beside the button). */
    placeholder?: ReactNode;
    /** What it chooses, said to screen readers when no label names it. */
    label?: string;
    /** The choose button's words, with nothing chosen (the app's "Choose a file"). */
    chooseLabel?: string;
    /** The choose button's words once a file is chosen or stored (the app's "Change"). */
    changeLabel?: string;
    /** The remove button's words (the app's "Remove"). */
    removeLabel?: string;
    /** A file already stored: its name or URL. */
    current?: string;
    /** Remove asked of the stored file (`current`): the app drops it. */
    onRemove?(): void;
    /** The files chosen, each time they change (none when removed). */
    onChange?(files: File[]): void;
    className?: string;
  },
): ReactNode {
  const input = useRef<HTMLInputElement>(null);
  const said = useId();
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);

  const chose = (chosen: File[]) => {
    setFiles(chosen);
    onChange?.(chosen);
  };
  const remove = () => {
    if (input.current) input.current.value = "";
    chose([]);
  };
  const dropped = (event: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const kept = keptOf([...event.dataTransfer.files], accept, multiple);
    if (!kept.length) return;
    // The file field holds them too, so a form sends what was dropped.
    try {
      const holder = new DataTransfer();
      for (const file of kept) holder.items.add(file);
      if (input.current) input.current.files = holder.files;
    } catch {
      // A browser that can't set a file field's files: the files are still told (onChange).
    }
    chose(kept);
  };

  const one = files.length === 1 ? files[0] : undefined;
  const stored = !files.length && current ? current : undefined;
  return (
    <div
      className={cx("copilotz-file-input", className)}
      data-chosen={files.length || stored ? "" : undefined}
      data-dragging={dragging ? "" : undefined}
      data-disabled={disabled ? "" : undefined}
      onDragEnter={(event) => {
        if (!carriesFiles(event) || disabled) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event) || disabled) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={dropped}
    >
      {SHEET}
      <input
        ref={input}
        type="file"
        className="copilotz-file-input-native"
        name={name}
        accept={accept}
        multiple={multiple}
        required={required}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => chose([...event.currentTarget.files ?? []])}
      />
      <button
        type="button"
        id={id}
        className="copilotz-file-input-choose"
        disabled={disabled}
        aria-label={label}
        aria-describedby={said}
        onClick={() => input.current?.click()}
      >
        <Icon name="attach" size={15} />
        {files.length || stored
          ? changeLabel ?? say("changeFile")
          : chooseLabel ?? (multiple ? say("chooseFiles") : say("chooseFile"))}
      </button>
      <span
        id={said}
        className="copilotz-file-input-text"
        aria-live="polite"
        title={files.map((f) => f.name).join(", ") || stored || undefined}
      >
        {dragging ? say("dropFiles") : one
          ? (
            <>
              {one.name}
              <span className="copilotz-file-input-size">{bytes(one.size)}</span>
            </>
          )
          : files.length
          ? say("files", { count: files.length })
          : stored
          ? nameOfStored(stored)
          : placeholder}
      </span>
      {!disabled && (files.length || (stored && onRemove))
        ? (
          <button
            type="button"
            className="copilotz-file-input-remove"
            onClick={files.length ? remove : onRemove}
          >
            {removeLabel ?? say("removeFile")}
          </button>
        )
        : null}
    </div>
  );
}
