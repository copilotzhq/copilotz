/**
 * Connection codes: what a person types into their computer to connect it,
 * kept only as a hash, and the space it's connected to (`in`: its first
 * desk). One works once, for minutes: it connects one computer (`computer`),
 * which may come back with it until it's been told its secret (a program
 * restarted in between), and then it's gone.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const enrollmentSchema = {
  type: "object",
  properties: {
    /** Whose computer it connects. */
    owner: { type: "string" },
    expires: { type: "string" },
    /** The space it's connected to. */
    in: { type: "string" },
    /** The computer it connected, until that computer has its secret. */
    computer: { type: "string" },
  },
  required: ["owner", "expires", "in"],
} as const;

export const enrollment = defineCollection({ schema: enrollmentSchema });

export type Enrollment = Infer<typeof enrollmentSchema> & { _id: string };
