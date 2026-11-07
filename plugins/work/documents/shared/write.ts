/**
 * How a document changes, for people's Actions and agents' tools alike:
 * each change is its next version, written with the document in one
 * transaction (read, then written, so nothing comes between), attributed
 * to who made it. The rules decide who may: a document someone can read
 * but not change doesn't match their write, and they're told so.
 */
import type { ReadContext, TransactionScope } from "../../../../runtime/mod.ts";
import type { Document } from "../collections/document.ts";
import { type DocumentVersion, versionId } from "../collections/document-version.ts";
import { changes } from "./diff.ts";
import { LIMIT, sizeOf, TITLE } from "./text.ts";

type Db = TransactionScope["db"];

/** An error with a code, as the runtime's are. */
export const fail = (message: string, code: string, more: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { code, ...more });

/** Who makes a change: `person:ana`, or `agent:north` working for `person:ana`. */
export type Author = { by: string; for?: string };

/** A change, as the version it makes: the title and text after it, and how it was made. */
export type Change = {
  title: string;
  text: string;
  kind: DocumentVersion["kind"];
  /** Saved over others' changes since version `base`, merged. */
  merged?: boolean;
  base?: number;
  /** Restored from this version. */
  from?: number;
};

/** What a change came to: the version it made (or that nothing changed), and how much. */
export type Written = {
  document: string;
  title: string;
  version: number;
  added: number;
  removed: number;
  unchanged?: true;
};

/** A title and text a document may have, or why not. */
export function checked(title: string, text: string): void {
  if (!title.trim()) throw fail("A document needs a title.", "invalid");
  if (title.length > TITLE) throw fail(`A title is at most ${TITLE} characters.`, "invalid");
  const size = sizeOf(text);
  if (size > LIMIT) {
    throw fail(
      `That's ${Math.ceil(size / 1024)} KB: a document holds at most ${LIMIT / 1024} KB. ` +
        "Split it into more than one.",
      "too_large",
    );
  }
}

/** The document, as whoever asks may read it; not there, or not theirs to see, it's `not_found`. */
export async function load(db: Db | ReadContext["db"], id: string): Promise<Document> {
  const doc = await db.collection<Document>("document").findOne({ _id: id });
  if (!doc) {
    throw fail(
      "No such document: it may have been deleted, or it's in a space you're not in.",
      "not_found",
    );
  }
  return doc as Document;
}

/** Someone who may read a document but not change it. */
const readOnly = () =>
  fail(
    "You can read this document but not change it: an editor or a manager of its space can.",
    "forbidden",
  );

/**
 * Writes `change` as `doc`'s next version, in the transaction that read
 * `doc`. Nothing changed (the same title and text), nothing is written.
 */
export async function commit(
  tx: TransactionScope,
  doc: Document,
  change: Change,
  author: Author,
): Promise<Written> {
  const { title, text } = change;
  if (title === doc.title && text === doc.text) {
    return {
      document: doc._id,
      title,
      version: doc.version,
      added: 0,
      removed: 0,
      unchanged: true,
    };
  }
  checked(title, text);
  const version = doc.version + 1;
  const at = new Date().toISOString();
  const { added, removed } = changes(doc.text, text);
  const saved = await tx.db.collection("document").updateOne(
    { _id: doc._id, version: doc.version },
    {
      $set: {
        title,
        text,
        version,
        size: sizeOf(text),
        savedBy: author.by,
        savedAt: at,
        ...(author.for ? { savedFor: author.for } : {}),
      },
      ...(author.for || !doc.savedFor ? {} : { $unset: { savedFor: true } }),
    },
  );
  if (!saved.matchedCount) throw readOnly();
  await tx.db.collection("documentVersion").insertOne({
    _id: versionId(doc._id, version),
    document: doc._id,
    in: doc.in,
    version,
    title,
    text,
    by: author.by,
    ...(author.for ? { for: author.for } : {}),
    at,
    kind: change.kind,
    ...(change.merged ? { merged: true, base: change.base } : {}),
    ...(change.from !== undefined ? { from: change.from } : {}),
    ...(title !== doc.title ? { renamed: doc.title } : {}),
    added,
    removed,
  });
  return { document: doc._id, title, version, added, removed };
}

/** Makes a document in `space`, as its first version. */
export async function create(
  tx: TransactionScope,
  space: string,
  title: string,
  text: string,
  author: Author,
): Promise<Written> {
  checked(title, text);
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  const { added } = changes("", text);
  await tx.db.collection("document").insertOne({
    _id: id,
    in: space,
    title,
    text,
    version: 1,
    size: sizeOf(text),
    createdBy: author.by,
    createdAt: at,
    savedBy: author.by,
    savedAt: at,
    ...(author.for ? { savedFor: author.for } : {}),
  });
  await tx.db.collection("documentVersion").insertOne({
    _id: versionId(id, 1),
    document: id,
    in: space,
    version: 1,
    title,
    text,
    by: author.by,
    ...(author.for ? { for: author.for } : {}),
    at,
    kind: "create",
    added,
    removed: 0,
  });
  return { document: id, title, version: 1, added, removed: 0 };
}

/** A rule's refusal to write somewhere ("out of your reach"), said plainly; others as they are. */
export function plainly(error: unknown): Error {
  const e = error as Error & { code?: unknown };
  if (e?.code === "forbidden" && /out of (your )?reach/.test(String(e.message))) {
    return fail(
      "You can read what's in this space but not add to it: an editor or a manager of it can.",
      "forbidden",
    );
  }
  return e;
}
