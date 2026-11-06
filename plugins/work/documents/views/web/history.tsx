/**
 * A document's History (kind `document.history`, item `{ _id }`, shown in
 * its page's drawer; hints `{ write }`, whether the person may restore):
 * every version, newest first, with who saved it (an agent, for whom), when,
 * how (made, saved, merged, renamed, restored, an agent's write, append or
 * edit) and the lines it added and removed. One opens (kind
 * `document.version`) as the change from the one before, in the toolkit's
 * added and removed tones, or as it read then; those who may change the
 * document restore it, as a new version.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Badge,
  Button,
  CopyButton,
  Icon,
  LazyView,
  Markdown,
  message,
  Notice,
  Skeleton,
  Tabs,
  Time,
} from "../../../../../hosts/web/mod.ts";
import type { DocumentVersion, Saved } from "../../contract.ts";
import { versionId } from "../../shared/text.ts";
import { Counts, Diff } from "./changes.tsx";
import { type Call, Face, said, shownAs, whoIn } from "./people.tsx";

/** How a version came to be, in a few words. */
export function how(v: Saved): string {
  switch (v.kind) {
    case "create":
      return "Made it";
    case "rename":
      return v.renamed ? `Renamed from “${v.renamed}”` : "Renamed it";
    case "restore":
      return `Brought back version ${v.from}`;
    case "write":
      return "Rewrote it";
    case "append":
      return "Added to the end";
    case "edit":
      return "Edited part of it";
    default:
      return v.merged ? `Saved, merged over changes since version ${v.base}` : "Saved";
  }
}

/** The page tells its drawer a version was restored with this event, to close it and say so. */
export const RESTORED = "documents:restored";

export const historyView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const id = item._id ?? "";
  const versions = ctx.db.collection("documentVersion").query<Saved[]>("history", {
    document: id,
  }).value;
  const known = whoIn(ctx, (versions ?? []).flatMap((v) => [v.by, v.for]));
  if (!versions) {
    return (
      <div className="doc-history-list" aria-busy="true">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={58} radius="lg" />)}
      </div>
    );
  }
  const start = typeof ctx.hints.version === "number" ? ctx.hints.version : undefined;
  return (
    <History
      document={id}
      versions={versions}
      shown={(key) => shownAs(key, known)}
      me={ctx.viewer?.name}
      write={ctx.hints.write === true}
      start={start}
    />
  );
};

function History(
  { document, versions, shown, me, write, start }: {
    document: string;
    versions: Saved[];
    shown: (key: string) => ReturnType<typeof shownAs>;
    me?: string;
    write: boolean;
    start?: number;
  },
): ReactNode {
  const [open, setOpen] = useState<number | undefined>(start);
  const latest = versions[0]?.version ?? 0;
  if (open !== undefined) {
    return (
      <div className="doc-history-one">
        <Button variant="ghost" size="sm" icon="chevron-left" onClick={() => setOpen(undefined)}>
          All versions
        </Button>
        <LazyView
          kind="document.version"
          item={{ _id: versionId(document, open) }}
          hints={{ write, latest }}
        />
      </div>
    );
  }
  return (
    <ol className="doc-history-list" aria-label="Versions, newest first">
      {versions.map((v) => {
        const who = shown(v.by);
        const helped = v.for ? shown(v.for) : undefined;
        return (
          <li key={v._id}>
            <button
              type="button"
              className="doc-version-row"
              aria-current={v.version === latest ? "true" : undefined}
              onClick={() => setOpen(v.version)}
            >
              <Face who={who} size={28} />
              <span className="doc-version-text">
                <span className="doc-version-top">
                  <b>Version {v.version}</b>
                  {v.version === latest ? <Badge tone="primary">Now</Badge> : null}
                  {v.merged ? <Badge tone="info">Merged</Badge> : null}
                </span>
                <span className="doc-version-what">
                  {said(who, me)}
                  {helped ? ` for ${said(helped, me, false)}` : ""} · {how(v)}
                </span>
              </span>
              <span className="doc-version-end">
                <Counts added={v.added} removed={v.removed} />
                <Time at={v.at} />
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export const versionView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const id = item._id ?? "";
  const v = ctx.db.collection<DocumentVersion>("documentVersion").findOne({ _id: id }).value;
  const before = v && v.version > 1
    ? ctx.db.collection<DocumentVersion>("documentVersion").findOne({
      _id: versionId(v.document, v.version - 1),
    }).value
    : null;
  const known = whoIn(ctx, [v?.by, v?.for]);
  if (v === undefined || before === undefined) {
    return (
      <div className="doc-version" aria-busy="true">
        <Skeleton height={22} width="60%" />
        <Skeleton height={260} radius="lg" />
      </div>
    );
  }
  if (!v) return <Notice tone="neutral">This version isn't here any more.</Notice>;
  return (
    <Version
      v={v}
      before={before}
      shown={(key) => shownAs(key, known)}
      me={ctx.viewer?.name}
      write={ctx.hints.write === true}
      latest={Number(ctx.hints.latest) || v.version}
      call={ctx.call}
    />
  );
};

function Version(
  { v, before, shown, me, write, latest, call }: {
    v: DocumentVersion;
    before: DocumentVersion | null;
    shown: (key: string) => ReturnType<typeof shownAs>;
    me?: string;
    write: boolean;
    latest: number;
    call: Call;
  },
): ReactNode {
  const [tab, setTab] = useState<"changes" | "read">(v.version === 1 ? "read" : "changes");
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const who = shown(v.by);
  const helped = v.for ? shown(v.for) : undefined;
  const restore = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const done = await call<{ version: number; unchanged?: true }>("document.restore", {
        document: v.document,
        version: v.version,
      });
      globalThis.dispatchEvent(
        new CustomEvent(RESTORED, {
          detail: { document: v.document, from: v.version, version: done.version },
        }),
      );
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  return (
    <article className="doc-version" aria-label={`Version ${v.version}`}>
      <header className="doc-version-head">
        <Face who={who} size={34} />
        <div>
          <h3>
            Version {v.version}
            {v.version === latest ? <Badge tone="primary">Now</Badge> : null}
          </h3>
          <p>
            {said(who, me)}
            {helped ? ` for ${said(helped, me, false)}` : ""} · <Time at={v.at} long /> · {how(v)}
          </p>
        </div>
        <Counts added={v.added} removed={v.removed} />
      </header>
      {v.renamed && v.renamed !== v.title
        ? (
          <p className="doc-version-renamed">
            <Icon name="pencil" size={13} /> Title: “{v.renamed}” → <b>“{v.title}”</b>
          </p>
        )
        : null}
      <Tabs
        label="Show"
        variant="line"
        value={tab}
        onChange={setTab}
        tabs={[
          ...(before
            ? [{ value: "changes" as const, label: `Changes from version ${before.version}` }]
            : []),
          { value: "read" as const, label: "As it read" },
        ]}
      />
      {tab === "changes" && before
        ? <Diff before={before.text} after={v.text} />
        : (
          <div className="doc-version-read">
            <span className="doc-version-copy">
              <CopyButton text={v.text} label="Copy its Markdown" />
            </span>
            <h4 className="doc-version-title">{v.title}</h4>
            {v.text.trim()
              ? <Markdown text={v.text} className="doc-md doc-md-small" />
              : <p className="doc-empty-preview">It was empty.</p>}
          </div>
        )}
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      {write && v.version !== latest
        ? (
          <div className="doc-version-foot">
            {asking
              ? (
                <Notice
                  tone="info"
                  icon="restore"
                  title={`Bring back version ${v.version}?`}
                  action={
                    <span className="doc-version-ask">
                      <Button
                        size="sm"
                        variant="primary"
                        loading={busy}
                        onClick={() => void restore()}
                      >
                        Restore it
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setAsking(false)}
                      >
                        Cancel
                      </Button>
                    </span>
                  }
                >
                  It becomes version{" "}
                  {latest + 1}, for everyone here. Nothing is lost: every version stays in History.
                </Notice>
              )
              : (
                <Button icon="restore" onClick={() => setAsking(true)}>
                  Restore this version
                </Button>
              )}
          </div>
        )
        : null}
    </article>
  );
}
