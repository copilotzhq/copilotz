/**
 * Computers people connected: one per machine, its owner's alone. Its secret
 * is kept only as a hash, and once in the clear (`pending`) until the
 * computer has it. Where it works, and for whom, are its desks: one per
 * space, with a folder of its own there (see desk.ts).
 */
import { defineCollection, type Infer, people } from "../../../../runtime/mod.ts";
import { costOf } from "../shared/cost.ts";

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
    /**
     * What an agent asks its person before doing here, in place of the
     * settings' `approve`: a computer of its own the app hosts (a cloud
     * computer, isolated) asks nothing. Publishing is always asked.
     */
    approve: { type: "array", items: { enum: ["terminal", "jobs", "writes"] } },
    /**
     * What the app says of a computer it keeps (a cloud computer, set with
     * `computer.mark`): its kind, how it is (`state`: asleep, awake…) and
     * its size; every desk of it shows the same, so a space's members see it.
     */
    status: {
      type: "object",
      properties: { kind: { type: "string" }, state: { type: "string" }, size: { type: "string" } },
      required: ["kind"],
    },
    /**
     * The plans' CLIs it runs agents' model calls on, by engine (`claude`,
     * `codex`, `antigravity`, `grok`, `cursor`), as it last said (see shared/engines.ts):
     * installed, signed in, as whom, and when.
     */
    engines: { type: "object" },
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
      allow: people,
      run: (computers) => computers.find({}, { sort: { seen: -1 } }),
    },
    /**
     * What one of the asker's computers the app keeps costs them
     * (`{ computer }`), or a new one (`{}`): `ComputerCost`, or null when the
     * app prices none (see shared/cost.ts).
     */
    cost: {
      allow: people,
      run: (computers, params: { computer?: string } = {}, ctx) =>
        costOf(
          ctx,
          computers as { findOne(filter: { _id: string }): Promise<Computer | null> },
          params.computer,
        ),
    },
  },
});

export type Computer = Infer<typeof computerSchema> & { _id: string };
