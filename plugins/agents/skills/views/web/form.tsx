/// <reference lib="dom" />
/**
 * The form a skill is written with, new or changed: from a SKILL.md
 * (dropped, uploaded with its folder, or pasted: its name, purpose and
 * instructions fill in, its other files join it), or field by field: its
 * name (typed as agents call it, `weekly-report`), when it's for (what
 * agents decide by), its instructions (written, or previewed as they'll
 * read), and its files, each opened to change in place. What's wrong is
 * said by the field it's about, as the Actions would say it, once Save is
 * pressed; Save sends only what changed.
 */
import { type DragEvent, type ReactNode, useId, useRef, useState } from "react";
import {
  Button,
  bytes,
  Icon,
  IconButton,
  Input,
  Markdown,
  message,
  Tabs,
  Textarea,
} from "../../../../../hosts/web/mod.ts";
import { LIMITS, nameOf, problems } from "../../shared/check.ts";
import {
  changes,
  type Draft,
  type DraftFile,
  freePath,
  fromPicked,
  merged,
  type Picked,
} from "./skills.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** What the fields show while empty: a SKILL.md to paste, and instructions. */
const PASTE =
  "---\nname: weekly-report\ndescription: Write the weekly report…\n---\n\n# Instructions";
const STEPS = "# Weekly report\n\n1. Read what shipped this week.\n2. …";

/** A file's text, or that it isn't text. */
async function picked(file: File, path = file.webkitRelativePath || file.name): Promise<Picked> {
  if (file.size > LIMITS.file * 4) return { path, text: "", binary: true };
  const text = await file.text();
  return { path, text, binary: text.slice(0, 8000).includes("\u0000") };
}

/** Everything under a dropped folder, by its path in it. */
async function walk(entry: FileSystemEntry, into: Promise<Picked>[]): Promise<void> {
  if (entry.isFile) {
    into.push(
      new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
        .then((file) => picked(file, entry.fullPath.replace(/^\//, ""))),
    );
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject)
    );
    if (!batch.length) return;
    for (const child of batch) await walk(child, into);
  }
}

/** What was dropped: files, and the files in folders. */
async function dropped(event: DragEvent): Promise<Picked[]> {
  const items = [...event.dataTransfer.items];
  const roots = items.map((item) => item.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry =>
    !!e
  );
  if (!roots.length) return await Promise.all([...event.dataTransfer.files].map((f) => picked(f)));
  const into: Promise<Picked>[] = [];
  for (const root of roots) await walk(root, into);
  return await Promise.all(into);
}

/** A name as it's typed: lowercase, words joined by dashes (the ends tidied when it's left). */
const typing = (value: string) =>
  value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+/, "").slice(0, LIMITS.name);

export function SkillForm(
  { space, skill, was, call, done, cancel, compact }: {
    /** The space it's in. */
    space: string;
    /** The skill being changed; none when it's new. */
    skill?: string;
    /** What it was (or starts as). */
    was: Draft;
    call: Call;
    /** Saved: its id. */
    done(skill: string): void;
    cancel?(): void;
    /** In a dialog: its end sticks to the dialog's bottom. */
    compact?: boolean;
  },
): ReactNode {
  const id = useId();
  const [draft, setDraft] = useState(was);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [view, setView] = useState<"write" | "preview">("write");
  const [open, setOpen] = useState<string>();
  const [said, setSaid] = useState<{ text: string; tone?: "warning" }>();
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [over, setOver] = useState(false);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<Draft>) => setDraft((now) => ({ ...now, ...patch }));
  const wrong = problems(draft);
  const shown = (field: string) =>
    tried || (field === "name" && draft.name) ? wrong[field] : undefined;
  const changed = skill ? changes(was, draft) : {};
  const fresh = !skill;

  /** What picked files bring: a SKILL.md's fields, and the rest as files. */
  const bring = (files: Picked[]) => {
    const got = fromPicked(files);
    setDraft((now) => ({
      name: got.md?.name ? typing(got.md.name).replace(/-+$/, "") : now.name,
      description: got.md?.description ?? now.description,
      instructions: got.md?.instructions || now.instructions,
      files: merged(now.files, got.files),
    }));
    const parts = [
      ...(got.md ? ["SKILL.md read: its name, purpose and instructions are filled in"] : []),
      ...(got.files.length
        ? [`${got.files.length} file${got.files.length === 1 ? "" : "s"} added`]
        : []),
    ];
    setSaid(
      got.skipped.length
        ? {
          text: `${parts.length ? `${parts.join("; ")}. ` : ""}Left out: ${
            got.skipped.join(", ")
          }.`,
          tone: "warning",
        }
        : parts.length
        ? { text: `${parts.join("; ")}.` }
        : { text: "Nothing to bring: pick a SKILL.md, or text files.", tone: "warning" },
    );
  };
  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    bring(await Promise.all([...list].map((f) => picked(f))));
  };
  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    const got = fromPicked(await Promise.all([...list].map((f) => picked(f, f.name))));
    set({ files: merged(draft.files, got.files) });
    if (got.skipped.length) {
      setSaid({ text: `Left out: ${got.skipped.join(", ")}.`, tone: "warning" });
    }
  };
  const file = (i: number, patch: Partial<DraftFile>) =>
    set({ files: draft.files.map((f, at) => at === i ? { ...f, ...patch } : f) });

  const save = async () => {
    setTried(true);
    if (busy || Object.keys(wrong).length) return;
    if (skill && !Object.keys(changed).length) return done(skill);
    setBusy(true);
    setError(undefined);
    try {
      const made = skill
        ? await call<{ skill: string }>("skill.update", { skill, ...changed })
        : await call<{ skill: string }>("skill.create", {
          in: space,
          name: draft.name.trim(),
          description: draft.description.trim(),
          instructions: draft.instructions,
          files: draft.files,
        });
      done(made.skill);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };

  return (
    <form
      className="skill-form"
      aria-label={fresh ? "A new skill" : `Change ${was.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div
        className="skill-import"
        data-over={over || undefined}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={async (event) => {
          event.preventDefault();
          setOver(false);
          bring(await dropped(event));
        }}
      >
        <span className="skill-import-say">
          <b>{fresh ? "Have a SKILL.md?" : "Replace it from a SKILL.md"}</b>
          <span>Drop it here with its files, upload its folder, or paste it.</span>
        </span>
        <span className="skill-import-buttons">
          <Button size="sm" icon="attach" onClick={() => filesInput.current?.click()}>
            Upload
          </Button>
          <Button size="sm" icon="folder" onClick={() => folderInput.current?.click()}>
            Folder
          </Button>
          <Button
            size="sm"
            variant={pasting ? "secondary" : "outline"}
            icon="copy"
            aria-expanded={pasting}
            onClick={() => setPasting(!pasting)}
          >
            Paste
          </Button>
        </span>
        <input
          ref={filesInput}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            void upload(event.target.files);
            event.target.value = "";
          }}
        />
        <input
          ref={folderInput}
          type="file"
          hidden
          {...{ webkitdirectory: "", directory: "" }}
          onChange={(event) => {
            void upload(event.target.files);
            event.target.value = "";
          }}
        />
        {said
          ? (
            <p className="skill-import-done" data-tone={said.tone} role="status">
              {said.text}
            </p>
          )
          : null}
      </div>
      {pasting
        ? (
          <div className="skill-paste">
            <Textarea
              autoFocus
              rows={6}
              value={pasted}
              aria-label="A SKILL.md, pasted"
              placeholder={PASTE}
              onChange={(event) => setPasted(event.target.value)}
            />
            <div className="skill-paste-end">
              <Button size="sm" variant="ghost" onClick={() => setPasting(false)}>Cancel</Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!pasted.trim()}
                onClick={() => {
                  bring([{ path: "SKILL.md", text: pasted }]);
                  setPasted("");
                  setPasting(false);
                }}
              >
                Use it
              </Button>
            </div>
          </div>
        )
        : null}

      <div className="skill-field skill-name">
        <label className="skill-label" htmlFor={`${id}-name`}>Name</label>
        <Input
          id={`${id}-name`}
          value={draft.name}
          autoFocus={fresh && !pasting}
          autoComplete="off"
          spellCheck={false}
          placeholder="weekly-report"
          disabled={busy}
          aria-describedby={`${id}-name-note`}
          aria-invalid={shown("name") ? true : undefined}
          onChange={(event) => set({ name: typing(event.target.value) })}
          onBlur={() => set({ name: nameOf(draft.name) })}
        />
        <p id={`${id}-name-note`} className={shown("name") ? "skill-error" : "skill-note"}>
          {shown("name") ?? "What agents call it: lowercase words joined by dashes."}
        </p>
      </div>

      <div className="skill-field">
        <div className="skill-label-row">
          <label className="skill-label" htmlFor={`${id}-what`}>When it's for</label>
          <span
            className="skill-count"
            data-over={draft.description.length > LIMITS.description || undefined}
          >
            {draft.description.length} / {LIMITS.description}
          </span>
        </div>
        <Textarea
          id={`${id}-what`}
          autoGrow
          rows={2}
          value={draft.description}
          disabled={busy}
          placeholder="Write the weekly report: what shipped, what's next, what's blocked. Use it when asked for a weekly update."
          aria-describedby={`${id}-what-note`}
          aria-invalid={shown("description") ? true : undefined}
          onChange={(event) => set({ description: event.target.value })}
        />
        <p id={`${id}-what-note`} className={shown("description") ? "skill-error" : "skill-note"}>
          {shown("description") ??
            "Agents see only this and its name until a task fits: say what it does, and when to use it."}
        </p>
      </div>

      <div className="skill-field skill-instructions">
        <div className="skill-label-row">
          <label className="skill-label" htmlFor={`${id}-how`}>Instructions</label>
          <Tabs
            label="Write or preview the instructions"
            value={view}
            onChange={setView}
            tabs={[{ value: "write", label: "Write" }, { value: "preview", label: "Preview" }]}
          />
        </div>
        {view === "write"
          ? (
            <Textarea
              id={`${id}-how`}
              autoGrow
              maxHeight={520}
              rows={10}
              value={draft.instructions}
              disabled={busy}
              spellCheck={false}
              placeholder={STEPS}
              aria-describedby={`${id}-how-note`}
              aria-invalid={shown("instructions") ? true : undefined}
              onChange={(event) => set({ instructions: event.target.value })}
            />
          )
          : (
            <div className="skill-preview" id={`${id}-how`} tabIndex={0}>
              {draft.instructions.trim()
                ? <Markdown text={draft.instructions} />
                : <p className="skill-preview-empty">Nothing written yet.</p>}
            </div>
          )}
        <p id={`${id}-how-note`} className={shown("instructions") ? "skill-error" : "skill-note"}>
          {shown("instructions") ??
            "In Markdown: what to do, step by step. Name a file here when agents should read it."}
        </p>
      </div>

      <div className="skill-field">
        <div className="skill-label-row">
          <span className="skill-label" id={`${id}-files`}>
            Files{" "}
            {draft.files.length ? <span className="skill-count">{draft.files.length}</span> : null}
          </span>
        </div>
        <ul className="skill-file-list" aria-labelledby={`${id}-files`}>
          {draft.files.map((f, i) => {
            const opened = open === `${i}`;
            const problem = shown(`files.${i}`);
            return (
              <li key={i} className="skill-file">
                <div className="skill-file-row">
                  <Icon name="file" size={16} />
                  <span className="skill-file-path">
                    <Input
                      size="sm"
                      value={f.path}
                      spellCheck={false}
                      aria-label={`File ${i + 1}'s path`}
                      aria-invalid={problem ? true : undefined}
                      disabled={busy}
                      onChange={(event) => file(i, { path: event.target.value })}
                    />
                  </span>
                  <span className="skill-file-size">{bytes(new Blob([f.text]).size)}</span>
                  <span>
                    <IconButton
                      icon={opened ? "chevron-down" : "pencil"}
                      label={opened ? `Fold ${f.path}` : `Change what ${f.path} says`}
                      size="sm"
                      onClick={() => setOpen(opened ? undefined : `${i}`)}
                    />
                    <IconButton
                      icon="trash"
                      label={`Remove ${f.path}`}
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        set({ files: draft.files.filter((_, at) => at !== i) });
                        setOpen(undefined);
                      }}
                    />
                  </span>
                </div>
                {problem ? <p className="skill-error skill-file-body">{problem}</p> : null}
                {opened
                  ? (
                    <div className="skill-file-body">
                      <Textarea
                        autoGrow
                        autoFocus
                        maxHeight={420}
                        rows={6}
                        value={f.text}
                        spellCheck={false}
                        aria-label={`What ${f.path} says`}
                        disabled={busy}
                        onChange={(event) => file(i, { text: event.target.value })}
                      />
                    </div>
                  )
                  : null}
              </li>
            );
          })}
        </ul>
        {shown("files") ? <p className="skill-error">{shown("files")}</p> : null}
        <div className="skill-file-adds">
          <Button
            size="sm"
            variant="ghost"
            icon="plus"
            disabled={busy || draft.files.length >= LIMITS.files}
            onClick={() => {
              set({ files: [...draft.files, { path: freePath(draft.files), text: "" }] });
              setOpen(`${draft.files.length}`);
            }}
          >
            Add a file
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="attach"
            disabled={busy}
            onClick={() => addInput.current?.click()}
          >
            Upload files
          </Button>
          <input
            ref={addInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              void addFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </div>
        <p className="skill-note">
          References, templates or scripts the instructions point to. Agents read one only when they
          need it.
        </p>
      </div>

      <div className={compact ? "skill-form-end" : "skill-form-end skill-form-end-page"}>
        {error
          ? <p className="skill-error" role="alert">{error}</p>
          : tried && Object.keys(wrong).length
          ? <p className="skill-error" role="alert">{Object.values(wrong)[0]}</p>
          : <p className="skill-note" aria-live="polite" />}
        {cancel ? <Button onClick={cancel} disabled={busy}>Cancel</Button> : null}
        <Button
          type="submit"
          variant="primary"
          icon={fresh ? "plus" : "check"}
          loading={busy}
          disabled={!fresh && !Object.keys(changed).length}
        >
          {fresh ? "Create skill" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
