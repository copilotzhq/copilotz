/**
 * Documents, for agents: the space's documents, offered wherever a
 * conversation is in a space. `list_documents`, `read_document` (by title
 * or id; an old version too), `write_document` (make one, or replace one
 * whole), `append_document`, and `edit_document` (replace text that occurs
 * exactly once). Each write reads and writes in one transaction, so an
 * agent never conflicts; it's a version like a person's save, attributed
 * to the agent (and the person it works for). Answers are short, and link
 * the document (`[Title](/document/<id>)`), so agents link it too.
 */
import { namesFor } from "../../../access/spaces/contract.ts";
import { type Thread, type Tool, tool, type ToolContext } from "../../../agents/chat/contract.ts";
import type { Document } from "../collections/document.ts";
import { type DocumentVersion, versionId } from "../collections/document-version.ts";
import { excerptOf, forOf, kb, keyOf, LIMIT, TITLE } from "../shared/text.ts";
import { agentNamer, nameOf, peopleOf } from "../shared/who.ts";
import { type Author, commit, create, type Written } from "../shared/write.ts";

type Ctx = ToolContext;
type Db = Ctx["db"];

/** The space the agent's conversation is in. */
const spaceOf = async (ctx: Ctx) =>
  (await ctx.db.collection<Thread>("thread").findOne({ _id: ctx.thread }))?.in;

const inSpace = (_agent: string, thread: Thread) => !!thread.in;

const author = (ctx: Ctx): Author => {
  const person = forOf(ctx.actor);
  return { by: keyOf({ kind: "agent", id: ctx.agent }), ...(person ? { for: person } : {}) };
};

/** A document as a link, for an answer: `[Launch plan](/document/<id>)`. */
const link = (doc: { _id?: string; document?: string; title: string }) =>
  `[${doc.title.replace(/[[\]]/g, "")}](/document/${doc._id ?? doc.document})`;

/** "2026-10-29 21:04" from an ISO time. */
const when = (at: string) => at.slice(0, 16).replace("T", " ");

/** Text as it's matched by title: any case, any accents, spaces as one. */
const fold = (text: string) =>
  text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The document an agent names, by its id (anywhere it may read) or its
 * title (in this space: exactly, else the one title that has it); or why
 * none, in words for the agent.
 */
async function named(db: Db, space: string, name: string): Promise<Document | string> {
  const asked = name.trim().replace(/^\/document\//, "").replace(/[?#].*$/, "");
  const byId = await db.collection<Document>("document").findOne({ _id: asked });
  if (byId) return byId as Document;
  const here = await db.collection<Document>("document").find({ in: space });
  const exact = here.filter((d) => fold(d.title) === fold(name));
  const near = exact.length ? exact : here.filter((d) => fold(d.title).includes(fold(name)));
  if (near.length === 1) return near[0] as Document;
  if (near.length > 1) {
    return `More than one document here is called that: ${
      near.map((d) => `${link(d)} (id ${d._id})`).join(", ")
    }. Name it by its id.`;
  }
  return `No document "${name}" here.` +
    (here.length
      ? ` These are: ${here.slice(0, 20).map((d) => `“${d.title}” (id ${d._id})`).join(", ")}.`
      : " There are none yet: write_document makes one.");
}

/** What an error says to an agent: the runtime's words, which say what would unblock it. */
const said = (error: unknown) => {
  const e = error as Error & { code?: string };
  if (e?.code === "forbidden") {
    return "You can read documents in this space but not change them: you work here as a " +
      "viewer. Tell the person, so a manager can make you an editor.";
  }
  return e instanceof Error ? e.message : String(error);
};

/** How a write ends, for the agent: what it made, and how much changed. */
function answer(w: Written, made = false): string {
  if (w.unchanged) return `No changes: ${link(w)} is already that (version ${w.version}).`;
  const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
  return made
    ? `Made ${link(w)} (version 1, ${lines(w.added)}).`
    : `Saved ${link(w)} as version ${w.version}: +${w.added} −${w.removed} lines.`;
}

/** Changes a named document in one transaction (read, then written): `change` says how. */
async function change(
  ctx: Ctx,
  name: string,
  how: (doc: Document) => { title?: string; text: string } | string,
  kind: DocumentVersion["kind"],
): Promise<string> {
  const space = await spaceOf(ctx);
  if (!space) return "This conversation isn't in a space: there are no documents here.";
  try {
    return await ctx.transaction(async (tx) => {
      const doc = await named(tx.db as Db, space, name);
      if (typeof doc === "string") return doc;
      const next = how(doc);
      if (typeof next === "string") return next;
      return answer(
        await commit(
          tx,
          doc,
          { title: next.title ?? doc.title, text: next.text, kind },
          author(ctx),
        ),
      );
    });
  } catch (error) {
    return said(error);
  }
}

const listDocuments = tool({
  offer: inSpace,
  description: "List this space's documents, latest saved first: each one's title (a link to " +
    "it), version, size, who saved it last and when, and how it opens. Read one with " +
    "read_document before you change it.",
  input: { type: "object", properties: {} },
  run: async (_, ctx) => {
    const space = await spaceOf(ctx);
    if (!space) return "This conversation isn't in a space: there are no documents here.";
    const docs = await ctx.db.collection<Document>("document").find({ in: space }, {
      sort: { savedAt: -1 },
    });
    if (!docs.length) return "No documents here yet. write_document makes one.";
    const name = agentNamer(ctx);
    const names = await namesFor(ctx, peopleOf(docs.map((d) => d.savedBy)));
    return `Documents here (${docs.length}), latest saved first:\n` + docs.map((d) => {
      const opens = excerptOf(d.text, d.title, 160);
      return [
        `- ${link(d)} · id ${d._id} · version ${d.version} · ${kb(d.size)} · saved by ` +
        `${nameOf(d.savedBy, name, names)} ${when(d.savedAt)}`,
        ...(opens ? [`  opens: ${opens}`] : []),
      ].join("\n");
    }).join("\n");
  },
});

const readDocument = tool({
  offer: inSpace,
  description: "Read a document of this space, by its title or id: its text (Markdown), with " +
    "its version and who saved it. With version, an older one, as it was then.",
  input: {
    type: "object",
    properties: {
      document: { type: "string", minLength: 1, description: "Its title or id." },
      version: { type: "integer", minimum: 1, description: "An older version (default: now)." },
    },
    required: ["document"],
  },
  run: async ({ document, version }, ctx) => {
    const space = await spaceOf(ctx);
    if (!space) return "This conversation isn't in a space: there are no documents here.";
    const doc = await named(ctx.db, space, document);
    if (typeof doc === "string") return doc;
    const name = agentNamer(ctx);
    const old = version && version !== doc.version
      ? await ctx.db.collection<DocumentVersion>("documentVersion").findOne({
        _id: versionId(doc._id, version),
      })
      : undefined;
    if (version && version !== doc.version && !old) {
      return `${link(doc)} has no version ${version}: it's at version ${doc.version}.`;
    }
    const shown = old
      ? { title: old.title, text: old.text, by: old.by, at: old.at }
      : { title: doc.title, text: doc.text, by: doc.savedBy, at: doc.savedAt };
    const names = await namesFor(ctx, peopleOf([shown.by]));
    const head = old
      ? `${link({ ...doc, title: shown.title })} · version ${version} of ${doc.version}, an old ` +
        `one (read it without version for now) · saved by ${nameOf(shown.by, name, names)} ` +
        when(shown.at)
      : `${link(doc)} · version ${doc.version} · ${kb(doc.size)} · saved by ` +
        `${nameOf(shown.by, name, names)} ${when(shown.at)}`;
    return `${head}\n\n${shown.text.trim() ? shown.text : "(It's empty.)"}`;
  },
});

const writeDocument = tool({
  offer: inSpace,
  description: "Make a new document in this space (title and text), or, naming one with " +
    "document, replace its whole text (and title, if given). To change part of one, prefer " +
    "edit_document or append_document: they keep what others wrote. Markdown.",
  input: {
    type: "object",
    properties: {
      title: { type: "string", maxLength: TITLE, description: "Its title." },
      text: { type: "string", maxLength: 4 * LIMIT, description: "Its whole text, in Markdown." },
      document: {
        type: "string",
        description: "An existing document to replace (its title or id). Leave out to make one.",
      },
    },
    required: ["text"],
  },
  run: async ({ title, text, document }, ctx) => {
    if (document) {
      return await change(
        ctx,
        document,
        () => ({ title: title?.trim() || undefined, text }),
        "write",
      );
    }
    const space = await spaceOf(ctx);
    if (!space) return "This conversation isn't in a space: there's nowhere to write.";
    const name = title?.trim();
    if (!name) return "A new document needs a title.";
    try {
      return await ctx.transaction(async (tx) => {
        const taken = (await tx.db.collection<Document>("document").find({ in: space }))
          .find((d) => fold(d.title) === fold(name));
        if (taken) {
          return `There's a document called that here already: ${link(taken)} (id ` +
            `${taken._id}, version ${taken.version}). Read it, then change it with ` +
            "edit_document or append_document, or replace it whole with write_document and " +
            "document; or give the new one another title.";
        }
        return answer(await create(tx, space, name, text, author(ctx)), true);
      });
    } catch (error) {
      return said(error);
    }
  },
});

const appendDocument = tool({
  offer: inSpace,
  description: "Add text to the end of a document of this space (by its title or id), after a " +
    "blank line. Markdown.",
  input: {
    type: "object",
    properties: {
      document: { type: "string", minLength: 1, description: "Its title or id." },
      text: { type: "string", minLength: 1, maxLength: 4 * LIMIT },
    },
    required: ["document", "text"],
  },
  run: ({ document, text }, ctx) =>
    change(ctx, document, (doc) => {
      const was = doc.text.replace(/\s+$/, "");
      return { text: was ? `${was}\n\n${text.replace(/^\n+/, "")}` : text };
    }, "append"),
});

const editDocument = tool({
  offer: inSpace,
  description: "Change part of a document of this space (by its title or id): replace text " +
    "that occurs exactly once in it (old, copied exactly, with enough around it to be " +
    "unique) with new text. Read it first.",
  input: {
    type: "object",
    properties: {
      document: { type: "string", minLength: 1, description: "Its title or id." },
      old: { type: "string", minLength: 1, description: "The text to replace, exactly." },
      new: { type: "string", description: "What goes in its place." },
    },
    required: ["document", "old", "new"],
  },
  run: ({ document, old, new: next }, ctx) =>
    change(ctx, document, (doc) => {
      const at = doc.text.indexOf(old);
      if (at < 0) {
        return `The text to replace isn't in ${link(doc)}: read it again (read_document) and ` +
          "copy it exactly.";
      }
      if (doc.text.indexOf(old, at + 1) >= 0) {
        const times = doc.text.split(old).length - 1;
        return `The text to replace occurs ${times > 1 ? `${times} times` : "more than once"} ` +
          `in ${link(doc)}: give more of what's around it.`;
      }
      return { text: doc.text.slice(0, at) + next + doc.text.slice(at + old.length) };
    }, "edit"),
});

export const tools: Record<string, Tool> = {
  list_documents: listDocuments,
  read_document: readDocument,
  write_document: writeDocument,
  append_document: appendDocument,
  edit_document: editDocument,
};
