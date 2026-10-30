/**
 * Computers people connected: one per machine, its owner's alone. Its secret
 * is kept only as a hash, and once in the clear (`pending`) until the
 * computer has it. Where it works, and for whom, are its desks: one per
 * space, with a folder of its own there (see desk.ts).
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const computerSchema = {
  type: "object",
  properties: {
    /** The person whose machine it is. */
    owner: { type: "string" },
    name: { type: "string" },
    /** Its secret's SHA-256. */
    secret: { type: "string" },
    /** Its secret, until it's been told it. */
    pending: { type: "string" },
    online: { type: "boolean" },
    /** When it last came or went. */
    seen: { type: "string" },
    /** What the machine is, as it said when it came (see Info). */
    info: { type: "object" },
    at: { type: "string" },
  },
  required: ["owner", "secret", "online", "at"],
} as const;

export const computer = defineCollection({
  schema: computerSchema,
  private: ["secret", "pending"],
  queries: {
    /** The asker's computers, the most recently seen first. */
    mine: {
      allow: (actor) => actor.kind === "person",
      run: (computers) => computers.find({}, { sort: { seen: -1 } }),
    },
  },
});

export type Computer = Infer<typeof computerSchema> & { _id: string };
