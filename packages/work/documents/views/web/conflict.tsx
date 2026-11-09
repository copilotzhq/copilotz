/**
 * When two saves changed the same lines: who saved what's there now, and
 * when, what yours would change in theirs (a diff), and three ways on:
 * keep yours (saved as a new version over theirs, which stays in History),
 * take theirs (yours put aside, to bring back), or merge by hand: each
 * place you both changed, side by side, to keep theirs, yours, both, or
 * lines of your own; the rest is merged already. Nothing of yours is lost
 * on the way: until it's saved, it's still your draft.
 */
import { type ReactNode, useMemo, useState } from "react";
import { Badge, Button, Card, CodeBlock, Icon, Notice, Tabs, Textarea, Time } from "copilotz/web";
import { type Chunk, merge, mergeField, type Pick, textOf } from "../../shared/merge.ts";
import { Diff } from "./changes.tsx";
import { Face, type Shown } from "./people.tsx";

/** What's there now, as the conflict screen shows it. */
export type Theirs = { text: string; title: string; version: number; at: string; by: Shown };

/** A version of the text and title. */
export type Sides = { text: string; title: string };

export function Conflict(
  { base, mine, theirs, busy, error, onKeep, onTake, onSave, onEdit }: {
    /** What both started from. */
    base: Sides & { version: number };
    mine: Sides;
    theirs: Theirs;
    busy: boolean;
    error?: string;
    onKeep(): void;
    onTake(): void;
    onSave(merged: Sides): void;
    onEdit(merged: Sides): void;
  },
): ReactNode {
  const [by, setBy] = useState<"choose" | "hand">("choose");
  const [view, setView] = useState<"both" | "theirs" | "mine">("both");
  const who = theirs.by.name;
  return (
    <section className="doc-conflict" aria-labelledby="doc-conflict-title">
      <div className="doc-conflict-head">
        <span className="doc-conflict-icon" aria-hidden="true">
          <Icon name="branch" size={18} />
        </span>
        <div>
          <h2 id="doc-conflict-title">
            {who} saved version {theirs.version} while you were editing version {base.version}
          </h2>
          <p>
            <Face who={theirs.by} size={18} /> {who} ·{" "}
            <Time at={theirs.at} long />. You both changed the same lines, so nothing was saved yet.
            Your text is safe here: choose what to keep.
          </p>
        </div>
      </div>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      {by === "choose"
        ? (
          <>
            <div className="doc-choices">
              <button type="button" className="doc-choice" disabled={busy} onClick={onKeep}>
                <span className="doc-choice-name">
                  <Icon name="check" size={15} /> Keep mine
                </span>
                <span className="doc-choice-says">
                  Save yours as version {theirs.version + 1}, over {who}'s. Theirs stays in History.
                </span>
              </button>
              <button type="button" className="doc-choice" disabled={busy} onClick={onTake}>
                <span className="doc-choice-name">
                  <Icon name="download" size={15} /> Take theirs
                </span>
                <span className="doc-choice-says">
                  Load {who}'s version{" "}
                  {theirs.version}. Yours is put aside, to bring back if you change your mind.
                </span>
              </button>
              <button
                type="button"
                className="doc-choice doc-choice-primary"
                disabled={busy}
                onClick={() => setBy("hand")}
              >
                <span className="doc-choice-name">
                  <Icon name="branch" size={15} /> Merge by hand
                </span>
                <span className="doc-choice-says">
                  Go through each place you both changed and choose. The rest is merged already.
                </span>
              </button>
            </div>
            <div className="doc-conflict-diff">
              <Tabs
                label="Which changes"
                variant="line"
                value={view}
                onChange={setView}
                tabs={[
                  { value: "both", label: "Yours against theirs" },
                  { value: "theirs", label: `${who}'s changes` },
                  { value: "mine", label: "Your changes" },
                ]}
              />
              {view === "both"
                ? (
                  <Diff
                    before={theirs.text}
                    after={mine.text}
                    title={`− ${who}'s version ${theirs.version} · + yours`}
                    empty="The texts are the same: only the titles differ."
                  />
                )
                : view === "theirs"
                ? (
                  <Diff
                    before={base.text}
                    after={theirs.text}
                    title={`What ${who} changed since version ${base.version}`}
                  />
                )
                : (
                  <Diff
                    before={base.text}
                    after={mine.text}
                    title={`What you changed since version ${base.version}`}
                  />
                )}
              {mine.title !== theirs.title
                ? (
                  <p className="doc-conflict-titles">
                    Titles: {who}'s <b>“{theirs.title}”</b>, yours <b>“{mine.title}”</b>.
                  </p>
                )
                : null}
            </div>
          </>
        )
        : (
          <ByHand
            base={base}
            mine={mine}
            theirs={theirs}
            busy={busy}
            back={() => setBy("choose")}
            onSave={onSave}
            onEdit={onEdit}
          />
        )}
    </section>
  );
}

/** A conflict's lines, as a block: whose, and what. */
function Side(
  { lines, title, tone }: { lines: string[]; title: ReactNode; tone: "theirs" | "mine" },
): ReactNode {
  return (
    <CodeBlock
      className={`doc-side doc-side-${tone}`}
      title={title}
      code={lines.join("\n")}
      empty="(nothing: these lines were taken out)"
      wrap
      lines={14}
    />
  );
}

/** The lines just before a conflict, for where it is. */
const before = (chunks: Chunk[], at: number) => {
  const prev = chunks[at - 1];
  return prev?.kind === "same" ? prev.lines.slice(-2).filter((l) => l.trim()) : [];
};

function ByHand(
  { base, mine, theirs, busy, back, onSave, onEdit }: {
    base: Sides;
    mine: Sides;
    theirs: Theirs;
    busy: boolean;
    back(): void;
    onSave(merged: Sides): void;
    onEdit(merged: Sides): void;
  },
): ReactNode {
  const merged = useMemo(() => merge(base.text, mine.text, theirs.text), [
    base.text,
    mine.text,
    theirs.text,
  ]);
  const clashes = merged.chunks.flatMap((c, i) => c.kind === "conflict" ? [{ c, i }] : []);
  const [picks, setPicks] = useState<(Pick | undefined)[]>([]);
  const [editing, setEditing] = useState<number>();
  const titled = mergeField(base.title, mine.title, theirs.title);
  const [title, setTitle] = useState<string | undefined>(titled);
  const settled = picks.filter(Boolean).length;
  const ready = settled === clashes.length && title !== undefined;
  const result = (): Sides => ({
    text: textOf(merged.chunks, clashes.map((_, n) => picks[n] ?? "mine")),
    title: title ?? mine.title,
  });
  const pick = (n: number, p: Pick) => {
    const next = [...picks];
    next[n] = p;
    setPicks(next);
  };
  const who = theirs.by.name;
  return (
    <div className="doc-hand">
      <div className="doc-hand-head">
        <Button variant="ghost" size="sm" icon="chevron-left" onClick={back}>Back</Button>
        <p role="status">
          {clashes.length ? `${settled} of ${clashes.length} settled` : "No lines clash any more"}
          {title === undefined ? " · the title too" : ""}
        </p>
      </div>
      {clashes.map(({ c, i }, n) => {
        if (c.kind !== "conflict") return null;
        const p = picks[n];
        const near = before(merged.chunks, i);
        return (
          <Card
            key={i}
            as="section"
            padding="none"
            className="doc-clash"
            data-settled={!!p || undefined}
          >
            <header className="doc-clash-head">
              <b>Clash {n + 1} of {clashes.length}</b>
              {near.length ? <span className="doc-clash-near">after “{near.at(-1)}”</span> : null}
              {p
                ? (
                  <Badge tone="success">
                    {p === "mine"
                      ? "Yours"
                      : p === "theirs"
                      ? `${who}'s`
                      : p === "both"
                      ? "Both"
                      : "Your own"}
                  </Badge>
                )
                : <Badge tone="warning">To choose</Badge>}
            </header>
            <div className="doc-clash-sides">
              <Side lines={c.theirs} title={`${who}'s`} tone="theirs" />
              <Side lines={c.mine} title="Yours" tone="mine" />
            </div>
            {editing === n
              ? (
                <OwnLines
                  start={typeof p === "object" ? p.lines : [...c.theirs, ...c.mine]}
                  done={(lines) => {
                    if (lines) pick(n, { lines });
                    setEditing(undefined);
                  }}
                />
              )
              : (
                <div className="doc-clash-picks" role="group" aria-label={`Clash ${n + 1}: keep`}>
                  <Button
                    size="sm"
                    variant={p === "theirs" ? "primary" : "outline"}
                    aria-pressed={p === "theirs"}
                    onClick={() => pick(n, "theirs")}
                  >
                    Use {who}'s
                  </Button>
                  <Button
                    size="sm"
                    variant={p === "mine" ? "primary" : "outline"}
                    aria-pressed={p === "mine"}
                    onClick={() => pick(n, "mine")}
                  >
                    Use yours
                  </Button>
                  <Button
                    size="sm"
                    variant={p === "both" ? "primary" : "outline"}
                    aria-pressed={p === "both"}
                    onClick={() => pick(n, "both")}
                  >
                    Both, {who}'s first
                  </Button>
                  <Button
                    size="sm"
                    variant={typeof p === "object" ? "primary" : "ghost"}
                    icon="pencil"
                    onClick={() => setEditing(n)}
                  >
                    Write it…
                  </Button>
                </div>
              )}
          </Card>
        );
      })}
      {titled === undefined
        ? (
          <Card
            as="section"
            padding="none"
            className="doc-clash"
            data-settled={title !== undefined || undefined}
          >
            <header className="doc-clash-head">
              <b>The title</b>
              {title !== undefined
                ? <Badge tone="success">Chosen</Badge>
                : <Badge tone="warning">To choose</Badge>}
            </header>
            <div className="doc-clash-picks" role="group" aria-label="The title: keep">
              <Button
                size="sm"
                variant={title === theirs.title ? "primary" : "outline"}
                onClick={() => setTitle(theirs.title)}
              >
                {who}'s: “{theirs.title}”
              </Button>
              <Button
                size="sm"
                variant={title === mine.title ? "primary" : "outline"}
                onClick={() => setTitle(mine.title)}
              >
                Yours: “{mine.title}”
              </Button>
            </div>
          </Card>
        )
        : null}
      <div className="doc-hand-foot">
        <Button
          variant="primary"
          icon="check"
          loading={busy}
          disabled={!ready}
          onClick={() => onSave(result())}
        >
          Save the merge as version {theirs.version + 1}
        </Button>
        <Button disabled={!ready || busy} icon="pencil" onClick={() => onEdit(result())}>
          Open it in the editor first
        </Button>
      </div>
    </div>
  );
}

/** Lines of one's own for a clash: a field with both sides to start from. */
function OwnLines(
  { start, done }: { start: string[]; done(lines?: string[]): void },
): ReactNode {
  const [text, setText] = useState(start.join("\n"));
  return (
    <div className="doc-own">
      <Textarea
        autoGrow
        maxHeight={360}
        value={text}
        aria-label="The lines to keep here"
        onChange={(event) => setText(event.target.value)}
        autoFocus
      />
      <div className="doc-clash-picks">
        <Button size="sm" variant="primary" onClick={() => done(text.split("\n"))}>
          Use these lines
        </Button>
        <Button size="sm" variant="ghost" onClick={() => done()}>Cancel</Button>
      </div>
    </div>
  );
}
