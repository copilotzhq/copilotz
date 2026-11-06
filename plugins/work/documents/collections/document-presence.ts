/**
 * Who has a document open right now, and who's editing it: one entry per
 * page open (a person's two tabs are two), kept in the owner's memory only
 * (`durable: false`: no store, no events, gone on restart). In the
 * document's space, so whoever reads the document sees who's there. Each
 * open page says it's still there every little while (`at`); one that
 * stops saying so is gone a minute later, even if it never said goodbye.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

export { BEAT_MS, presenceId, STALE_MS } from "../shared/presence.ts";

const presenceSchema = {
  type: "object",
  properties: {
    document: { type: "string" },
    in: { type: "string" },
    /** Who: `person:ana`. */
    who: { type: "string" },
    /** `open`: reading it, or with nothing unsaved; `editing`: with changes not yet saved. */
    state: { enum: ["open", "editing"] },
    /** When the page last said so. */
    at: { type: "string" },
  },
  required: ["document", "in", "who", "state", "at"],
} as const;

export type Presence = Infer<typeof presenceSchema> & { _id: string };

export const documentPresence = defineCollection({ durable: false, schema: presenceSchema });
