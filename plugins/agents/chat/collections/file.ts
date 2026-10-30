/**
 * Files attached to messages. Their content (`data`, base64) is kept as a
 * blob, by the hash of what it holds: the same file attached twice is stored
 * once, and a store's blobs can live elsewhere (a directory, a bucket).
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const fileSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    /** Its media type: `text/plain`, `image/png`… */
    type: { type: "string" },
    /** Bytes. */
    size: { type: "integer" },
    /** The content, base64. */
    data: { type: "string" },
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
    at: { type: "string" },
  },
  required: ["name", "type", "size", "data", "thread", "at"],
} as const;

export const file = defineCollection({
  schema: fileSchema,
  queries: {
    /** One file, content and all, as its reader reaches it: what the web serves at `/files/<id>`. */
    content: {
      allow: (actor) => actor.kind === "person",
      run: (files, params: { id: string }) => files.findOne({ _id: params.id }),
    },
  },
});

export type File = Infer<typeof fileSchema> & { _id: string };

/** Media types read as text: what agents get the content of. */
export const textual = (type: string) =>
  type.startsWith("text/") || /json|xml|yaml|csv|javascript|typescript/.test(type);

/** A base64 file's content as text. */
export const text = (data: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
