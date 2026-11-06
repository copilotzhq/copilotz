/**
 * A space's documents (kind `documents`: its Documents tab, item `{ _id }`,
 * the space): each one's title, how it opens, who changed it last and when,
 * how many versions it has, and who's in it right now; latest first, with a
 * search once there are many. A new one in a click (or from a template),
 * each one's menu (copy its link, rename, delete). With none yet, it says
 * what documents are for here, and how to start one.
 *
 * Beside a chat (`hints.mode === "panel"`), the same, compact; a document
 * opens there to read (kind `document.read`), with Edit opening its page.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Button,
  Chip,
  EmptyState,
  go,
  Icon,
  IconButton,
  Input,
  LazyView,
  Markdown,
  Menu,
  type MenuItem,
  message,
  Notice,
  openPalette,
  type PaletteStep,
  Skeleton,
  Time,
} from "../../../../../hosts/web/mod.ts";
import type { Document, Listed, Presence } from "../../contract.ts";
import { documentPath, kb, TITLE } from "../../shared/text.ts";
import { DeleteDialog } from "./page.tsx";
import {
  type Call,
  count,
  Face,
  type Place,
  placeName,
  said,
  type Shown,
  shownAs,
  useNow,
  whoIn,
  writes,
} from "./people.tsx";
import { hereNow, named, Present } from "./presence.tsx";
import { STYLE } from "./style.ts";

const style = <style href="documents-web" precedence="copilotz">{STYLE}</style>;

/** Past this many, a search shows. */
const SEARCHED = 6;

/** Ways to start, each a title and the bones of what goes under it. */
export const TEMPLATES: { key: string; label: string; title: string; text: string }[] = [
  {
    key: "plan",
    label: "A plan",
    title: "Plan",
    text:
      "## Goal\n\nWhat we're after, and how we'll know we got there.\n\n## Steps\n\n- [ ] \n\n" +
      "## Risks\n\n- \n\n## Open questions\n\n- ",
  },
  {
    key: "meeting",
    label: "Meeting notes",
    title: "Meeting notes",
    text: "**When:** \n**Who:** \n\n## Agenda\n\n- \n\n## Notes\n\n\n\n## Decisions\n\n- \n\n" +
      "## Next steps\n\n- [ ] ",
  },
  {
    key: "decision",
    label: "A decision",
    title: "Decision: ",
    text: "## Context\n\nWhat's going on, and why we must choose.\n\n## Options\n\n1. \n2. \n\n" +
      "## Decision\n\n\n\n## What follows from it\n\n- ",
  },
  {
    key: "brief",
    label: "A brief",
    title: "Brief",
    text: "## The problem\n\n\n\n## Who it's for\n\n\n\n## What good looks like\n\n\n\n" +
      "## Constraints\n\n- ",
  },
];

/** Makes a document in `space` and opens it, its title ready to type over. */
export async function newDocument(
  call: Call,
  space: string,
  start?: { title?: string; text?: string },
): Promise<void> {
  const { document } = await call<{ document: string }>("document.create", {
    in: space,
    ...(start?.title ? { title: start.title } : {}),
    ...(start?.text ? { text: start.text } : {}),
  });
  go(`${documentPath(document, space)}&new=1`);
}

/** Renaming a document from the command palette: its title, ready to type over. */
export function renameStep(doc: Pick<Listed, "_id" | "title">, call: Call): PaletteStep {
  return {
    title: `Rename “${doc.title}”`,
    placeholder: "Its new title",
    value: doc.title,
    note: "A new title is a new version: everyone here sees it, and History keeps the old one.",
    filter: false,
    items: (search) => {
      const title = search.trim();
      if (!title || title === doc.title) return [];
      const long = title.length > TITLE;
      return [{
        title: "",
        items: [{
          key: "document:rename",
          label: `Rename to “${title}”`,
          icon: "pencil",
          disabled: long,
          ...(long ? { description: `At most ${TITLE} characters` } : {}),
          run: () => call("document.rename", { document: doc._id, title }),
        }],
      }];
    },
  };
}

/** Text as it's matched: any case, any accents. */
const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export const documentsView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const space = item._id ?? (typeof ctx.hints.in === "string" ? ctx.hints.in : "");
  const compact = ctx.hints.mode === "panel";
  const listed = ctx.db.collection("document").query<Listed[]>("list", { in: space }).value;
  const places = ctx.db.collection("space").query<Place[]>("reached", {}).value;
  const presence = ctx.db.collection<Presence>("documentPresence").find({ in: space }).value;
  const known = whoIn(ctx, [
    ...(listed ?? []).flatMap((d) => [d.savedBy, d.savedFor]),
    ...(presence ?? []).map((p) => p.who),
  ]);
  if (!listed || !places) {
    return (
      <div className={`docs${compact ? " docs-compact" : ""}`} aria-busy="true">
        {style}
        {[0, 1, 2].map((i) => <Skeleton key={i} height={compact ? 54 : 84} radius="lg" />)}
      </div>
    );
  }
  const place = places.find((p) => p._id === space);
  return (
    <>
      {style}
      <Documents
        space={space}
        where={place ? placeName(place) : "this space"}
        write={writes(place)}
        docs={listed}
        presence={presence ?? []}
        shown={(key) => shownAs(key, known)}
        me={ctx.viewer?.name}
        compact={compact}
        call={ctx.call}
      />
    </>
  );
};

function Documents(
  { space, where, write, docs, presence, shown, me, compact, call }: {
    space: string;
    where: string;
    write: boolean;
    docs: Listed[];
    presence: Presence[];
    shown: (key: string) => Shown;
    me?: string;
    compact: boolean;
    call: Call;
  },
): ReactNode {
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [reading, setReading] = useState<string>();
  const [deleting, setDeleting] = useState<Listed>();
  const now = useNow(15_000);
  const start = async (key: string, from?: { title?: string; text?: string }) => {
    setBusy(key);
    setError(undefined);
    try {
      await newDocument(call, space, from);
    } catch (e) {
      setError(message(e));
      setBusy(undefined);
    }
  };

  if (compact && reading) {
    return (
      <div className="docs docs-compact">
        <div className="docs-reader-back">
          <Button
            variant="ghost"
            size="sm"
            icon="chevron-left"
            onClick={() => setReading(undefined)}
          >
            Documents
          </Button>
        </div>
        <LazyView
          kind="document.read"
          item={{ _id: reading }}
          hints={{ in: space, mode: "panel" }}
        />
      </div>
    );
  }

  const failed = error ? <Notice tone="destructive" role="alert">{error}</Notice> : null;
  if (!docs.length) {
    return (
      <div className={`docs${compact ? " docs-compact" : ""}`}>
        <EmptyState
          icon="file"
          tone="primary"
          title="Write it down, together"
          className="docs-empty"
          action={write
            ? (
              <Button
                variant="primary"
                icon="plus"
                loading={busy === "blank"}
                onClick={() => void start("blank")}
              >
                New document
              </Button>
            )
            : null}
        >
          Documents hold the work itself: the plan, the draft, the decision. Everyone here, people
          and agents, reads and improves the same one, and every save is a version you can compare
          or bring back.
        </EmptyState>
        {failed}
        {write
          ? (
            <div className="docs-start">
              <p className="docs-start-label">Or start from</p>
              <div className="docs-start-chips">
                {TEMPLATES.map((t) => (
                  <Chip
                    key={t.key}
                    variant="outline"
                    onClick={() => void start(t.key, t)}
                  >
                    {busy === t.key ? "Making it…" : t.label}
                  </Chip>
                ))}
              </div>
              <p className="docs-start-hint">
                <Icon name="sparkles" size={14} />{" "}
                Or ask an agent in a chat here: “draft our launch plan as a document”. It shows up
                here, and you'll see each change it makes.
              </p>
            </div>
          )
          : (
            <p className="docs-start-hint">
              Editors of {where} add documents here, and so do its agents.
            </p>
          )}
      </div>
    );
  }

  const words = fold(search).split(/\s+/).filter(Boolean);
  const found = docs.filter((d) => {
    const text = fold(`${d.title} ${d.excerpt}`);
    return words.every((w) => text.includes(w));
  });
  const rows = found.map((d) => {
    const who = shown(d.savedBy);
    const here = hereNow(presence.filter((p) => p.document === d._id), now, me, shown);
    const editing = here.filter((h) => h.editing);
    const items: (MenuItem | "separator")[] = [
      { label: "Open", icon: "external", href: documentPath(d._id, space) },
      {
        label: "Copy link",
        icon: "copy",
        onSelect: () => void navigator.clipboard?.writeText(`${location.origin}/document/${d._id}`),
      },
      ...(write
        ? [
          {
            label: "Rename…",
            icon: "pencil" as const,
            onSelect: () => openPalette(renameStep(d, call)),
          },
          "separator" as const,
          {
            label: "Delete…",
            icon: "trash" as const,
            tone: "destructive" as const,
            onSelect: () => setDeleting(d),
          },
        ]
        : []),
    ];
    const open = compact
      ? { as: "button" as const, onClick: () => setReading(d._id) }
      : { as: "a" as const, href: documentPath(d._id, space) };
    const inner = (
      <>
        <span className="docs-row-icon" aria-hidden="true">
          <Icon name="file" size={compact ? 15 : 17} />
        </span>
        <span className="docs-row-text">
          <span className="docs-row-title">{d.title}</span>
          {d.excerpt && !compact ? <span className="docs-row-excerpt">{d.excerpt}</span> : null}
          <span className="docs-row-meta">
            <Face who={who} size={16} />
            <span>{said(who, me)}</span>
            <span aria-hidden="true">·</span>
            <Time at={d.savedAt} />
            {compact ? null : (
              <>
                <span aria-hidden="true">·</span>
                <span>{count(d.version, "version")}</span>
                <span aria-hidden="true">·</span>
                <span>{kb(d.size)}</span>
              </>
            )}
          </span>
        </span>
        {here.length
          ? (
            <span className="docs-row-here">
              {editing.length && !compact
                ? <span className="docs-row-editing">{named(editing)} editing</span>
                : null}
              <Present here={here} most={3} size={20} />
            </span>
          )
          : null}
      </>
    );
    return (
      <li key={d._id} className="docs-item">
        {open.as === "a"
          ? <a className="docs-row" href={open.href}>{inner}</a>
          : <button type="button" className="docs-row" onClick={open.onClick}>{inner}</button>}
        <span className="docs-row-menu">
          <Menu label={`${d.title}: more`} align="end" size="sm" items={items} />
        </span>
      </li>
    );
  });

  return (
    <div className={`docs${compact ? " docs-compact" : ""}`}>
      {compact ? null : (
        <div className="docs-head">
          <p className="docs-intro">
            The work itself, written down: people and agents here read and improve the same
            documents, and every save is a version.
          </p>
          {write
            ? (
              <Button
                variant="primary"
                icon="plus"
                loading={busy === "blank"}
                onClick={() => void start("blank")}
              >
                New document
              </Button>
            )
            : null}
        </div>
      )}
      {failed}
      {docs.length > SEARCHED || compact
        ? (
          <div className="docs-head">
            <Input
              icon="search"
              type="search"
              size={compact ? "sm" : "md"}
              className="docs-search"
              aria-label="Search documents"
              placeholder={`Search ${count(docs.length, "document")}`}
              autoComplete="off"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {compact && write
              ? (
                <IconButton
                  icon="plus"
                  label="New document"
                  variant="outline"
                  loading={busy === "blank"}
                  onClick={() => void start("blank")}
                />
              )
              : null}
          </div>
        )
        : null}
      {rows.length
        ? <ul className="docs-list" aria-label={`Documents in ${where}`}>{rows}</ul>
        : <p className="docs-none">No documents match “{search}”.</p>}
      {deleting
        ? (
          <DeleteDialog
            open
            onClose={() => setDeleting(undefined)}
            doc={deleting}
            where={where}
            call={call}
          />
        )
        : null}
    </div>
  );
}

/** A document to read beside a chat (kind `document.read`, item `{ _id }`): Edit opens its page. */
export const readView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const id = item._id ?? "";
  const doc = ctx.db.collection<Document>("document").findOne({ _id: id }).value;
  const places = ctx.db.collection("space").query<Place[]>("reached", {}).value;
  const known = whoIn(ctx, [doc?.savedBy, doc?.savedFor]);
  if (doc === undefined || !places) {
    return (
      <div className="doc-reader" aria-busy="true">
        {style}
        <Skeleton height={24} width="70%" />
        <Skeleton height={200} radius="lg" />
      </div>
    );
  }
  if (!doc) {
    return (
      <div className="doc-reader">
        {style}
        <Notice tone="neutral">This document isn't here any more.</Notice>
      </div>
    );
  }
  const place = places.find((p) => p._id === doc.in);
  const who = shownAs(doc.savedBy, known);
  return (
    <article className="doc-reader" aria-labelledby={`doc-reader-${id}`}>
      {style}
      <header className="doc-reader-head">
        <div>
          <h2 id={`doc-reader-${id}`}>{doc.title}</h2>
          <p>
            Version {doc.version} · {said(who, ctx.viewer?.name)} · <Time at={doc.savedAt} />
          </p>
        </div>
        <Button
          size="sm"
          variant={writes(place) ? "primary" : "outline"}
          icon={writes(place) ? "pencil" : "external"}
          href={documentPath(doc._id, doc.in)}
        >
          {writes(place) ? "Edit" : "Open"}
        </Button>
      </header>
      {doc.text.trim()
        ? <Markdown text={doc.text} className="doc-md doc-md-small" />
        : <p className="doc-empty-preview">Nothing written yet.</p>}
    </article>
  );
};
