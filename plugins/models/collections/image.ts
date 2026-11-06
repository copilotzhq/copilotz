/**
 * Images models made (`image.generate`), a document each: its media type,
 * its size in bytes and its content (base64, kept as a blob by the hash of
 * what it holds, so the same image attached elsewhere is stored once), the
 * model that made it, what it was for (`tags`) and when.
 *
 * No rule speaks for it: nobody outside reads it directly. Plugin code reads
 * an image by its id (an app's tool, to attach it to a message), and
 * `image.generate` takes one as a reference.
 */
import { defineCollection, type Infer } from "../../../runtime/mod.ts";

const imageSchema = {
  type: "object",
  properties: {
    /** Its media type: `image/png`… */
    type: { type: "string" },
    size: { type: "integer" },
    /** The content, base64. */
    data: { type: "string" },
    /** The model that made it (`"provider/model"`). */
    model: { type: "string" },
    tags: { type: "object", additionalProperties: { type: "string" } },
    at: { type: "string" },
  },
  required: ["type", "size", "data", "model", "at"],
} as const;

export const image = defineCollection({ schema: imageSchema, events: false });

export type Image = Infer<typeof imageSchema> & { _id: string };
