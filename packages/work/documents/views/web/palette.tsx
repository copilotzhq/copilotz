/**
 * What documents offer in the command palette (kind `document.palette`, the
 * web shell's `palette` resource), for where the person is and what's typed:
 *
 * - **This document**, on a document's page: its History, its link, its
 *   Markdown, renaming it and deleting it (those who may change it), and its
 *   space's documents;
 * - **This space:** its Documents tab;
 * - **Documents**, while searching: the latest anywhere the person reaches,
 *   to go to;
 * - **Create:** a new document where they are, named as they type.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "copilotz";
import { go, type PaletteGroup, type PaletteItem, type PaletteStep } from "copilotz/web";
import type { Document, Listed } from "../../contract.ts";
import { documentPath, documentsTab, TITLE } from "../../shared/text.ts";
import { newDocument, renameStep } from "./list.tsx";
import { type Call, type Place, placeName, writes } from "./people.tsx";

/** Deleting a document, once they've read what it means; then its space's documents. */
const deleteStep = (doc: Document, call: Call): PaletteStep => ({
  title: `Delete “${doc.title}”?`,
  confirm: true,
  note: `It goes for everyone in its space, with its ${doc.version} version${
    doc.version === 1 ? "" : "s"
  }. This can't be undone.`,
  items: () => [{
    title: "",
    items: [
      {
        key: "document:delete",
        label: `Delete “${doc.title}”`,
        icon: "trash",
        tone: "destructive",
        run: async () => {
          await call("document.delete", { document: doc._id });
          go(documentsTab(doc.in));
        },
      },
      { key: "document:keep", label: "Keep it", icon: "close", run: (p) => p.back() },
    ],
  }],
});

/** Naming a new document in `space`, then opening it. */
const newStep = (space: string, where: string, call: Call): PaletteStep => ({
  title: `New document in ${where}`,
  placeholder: "Its title (or name it later)",
  filter: false,
  items: (search) => {
    const title = search.trim();
    const long = title.length > TITLE;
    return [{
      title: "",
      items: [{
        key: "document:create",
        label: title ? `Create “${title}”` : "Create an untitled document",
        icon: "plus",
        disabled: long,
        ...(long ? { description: `At most ${TITLE} characters` } : {}),
        run: () => newDocument(call, space, title ? { title } : undefined),
      }],
    }];
  },
});

export const documentsPaletteView = (
  _: unknown,
  ctx: ViewContext<ReactNode>,
): PaletteGroup[] | null => {
  const searching = !!String(ctx.hints.search ?? "").trim();
  const page = (ctx.hints.page ?? {}) as { kind?: string; id?: string };
  const open = page.kind === "document" && page.id
    ? ctx.db.collection<Document>("document").findOne({ _id: page.id }).value
    : null;
  const here = typeof ctx.hints.in === "string" ? ctx.hints.in : open?.in;
  const places = ctx.db.collection("space").query<Place[]>("reached", {}).value;
  const recent = searching
    ? ctx.db.collection("document").query<Listed[]>("recent", { limit: 50 }).value
    : [];
  if (!places || open === undefined || !recent) return null;
  const place = places.find((p) => p._id === here);
  const groups: PaletteGroup[] = [];
  if (open) {
    const home = places.find((p) => p._id === open.in);
    const write = writes(home);
    const items: PaletteItem[] = [
      {
        key: "document:history",
        label: "History",
        icon: "retry",
        keywords: ["versions", "changes", "diff", "restore"],
        href: `${documentPath(open._id, open.in)}&history=1`,
      },
      {
        key: "document:link",
        label: "Copy link",
        icon: "copy",
        keywords: ["share", "url"],
        run: () => navigator.clipboard?.writeText(`${location.origin}/document/${open._id}`),
      },
      {
        key: "document:download",
        label: "Download Markdown",
        icon: "download",
        keywords: ["export", "md", "file"],
        run: () => {
          const url = URL.createObjectURL(new Blob([open.text], { type: "text/markdown" }));
          Object.assign(document.createElement("a"), { href: url, download: `${open.title}.md` })
            .click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        },
      },
      ...(write
        ? [{
          key: "document:rename",
          label: `Rename “${open.title}”…`,
          icon: "pencil" as const,
          keywords: ["title"],
          step: renameStep(open, ctx.call),
        }]
        : []),
      ...(home
        ? [{
          key: "document:all",
          label: `${placeName(home)}'s documents`,
          icon: "file" as const,
          href: documentsTab(home._id),
        }]
        : []),
      ...(write
        ? [{
          key: "document:delete-step",
          label: `Delete “${open.title}”…`,
          icon: "trash" as const,
          tone: "destructive" as const,
          step: deleteStep(open, ctx.call),
        }]
        : []),
    ];
    // What's open comes first: before its space's.
    groups.push({ title: "This document", order: 8, items });
  } else if (here && place) {
    groups.push({
      title: "This space",
      order: 10,
      items: [{
        key: "document:tab",
        label: "Documents",
        icon: "file",
        description: "Plans, drafts and decisions",
        keywords: ["documents", "docs", "notes", "writing", "markdown"],
        href: documentsTab(here),
      }],
    });
  }
  if (searching && recent.length) {
    const names = new Map(places.map((p) => [p._id, placeName(p)]));
    groups.push({
      title: "Documents",
      order: 32,
      limit: 6,
      items: recent.map((d) => ({
        key: `document:${d._id}`,
        label: d.title,
        icon: "file" as const,
        description: names.get(d.in) ?? "",
        keywords: [d.excerpt.slice(0, 160)],
        href: documentPath(d._id, d.in),
      })),
    });
  }
  if (here && place && writes(place)) {
    groups.push({
      title: "Create",
      order: 40,
      items: [{
        key: "document:new",
        label: "New document…",
        icon: "file",
        description: placeName(place),
        keywords: ["document", "doc", "write", "markdown", "page"],
        step: newStep(here, placeName(place), ctx.call),
      }],
    });
  }
  return groups;
};
