/**
 * Files attached to messages. Their content (`data`, base64) is kept as a
 * blob, by the hash of what it holds: the same file attached twice is stored
 * once, and a store's blobs can live elsewhere (a directory, a bucket).
 *
 * Nothing answers a file whole: a query's answer comes from an executor in
 * one piece, which is no way to move megabytes. `file.about` says what a
 * file is, and `/files/<id>` (routes/files.ts) streams its content.
 */
import { defineCollection, type Infer, peopleOrContacts } from "../../../../runtime/mod.ts";

/**
 * Base64 as `data` holds it: the alphabet and its padding, nothing else (no
 * line breaks, no `data:` prefix), so any four characters from the start of
 * a group decode on their own, and a file is served in parts.
 */
export const BASE64 = "^[A-Za-z0-9+/]*={0,2}$";

const fileSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    /** Its media type: `text/plain`, `image/png`… */
    type: { type: "string" },
    /** Bytes. */
    size: { type: "integer" },
    /** The content, base64. */
    data: { type: "string", pattern: BASE64 },
    /** A recording's length (ms) and its loudness over time (up to 64 values, 0–1), for its player. */
    voice: {
      type: "object",
      properties: {
        duration: { type: "number" },
        peaks: { type: "array", items: { type: "number" }, maxItems: 64 },
      },
      required: ["duration"],
    },
    /** What an audio file says, transcribed when it was sent: what agents read. */
    transcript: { type: "string" },
    thread: { type: "string" },
    /** The space its thread is in. */
    in: { type: "string" },
    /**
     * A tool's, from what it was given (an API's response), as an agent's
     * step is: those in the conversation from outside (a contact) never read it.
     */
    private: { type: "boolean" },
    at: { type: "string" },
  },
  required: ["name", "type", "size", "data", "thread", "at"],
} as const;

export const file = defineCollection({
  schema: fileSchema,
  queries: {
    /**
     * One file as its reader reaches it, all but its content (`data`): what
     * `/files/<id>` checks before it streams that. A contact reaches those of
     * its own chat (what was sent there), never a tool's. Left out as it's
     * read, the content isn't even loaded.
     */
    about: {
      allow: peopleOrContacts,
      run: (files, params: { id: string }) =>
        files.findOne({ _id: params.id }, { projection: { data: 0 } }),
    },
  },
});

export type File = Infer<typeof fileSchema> & { _id: string };

/** A file as `file.about` answers it: everything but its content. */
export type FileAbout = Pick<
  File,
  "_id" | "name" | "type" | "size" | "voice" | "transcript" | "thread" | "in" | "private" | "at"
>;

/** Media types read as text: what agents get the content of. */
/** How much of a text file an agent is sent. */
export const FILE_CHARS = 20_000;

export const textual = (type: string): boolean =>
  type.startsWith("text/") || /json|xml|yaml|csv|javascript|typescript/.test(type);

/** A base64 file's content as text. */
export const text = (data: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
