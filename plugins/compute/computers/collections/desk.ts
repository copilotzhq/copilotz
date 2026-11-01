/**
 * A computer's desk in a space: where that space's work happens on it (its
 * folder there). It's shared with the space's members (the `shared`
 * resource: `in`), who use it from the space, and whose agents do, in its
 * conversations. Its owner, whose computer it is, puts it there and takes
 * it away; a space's managers may take it away too. Who answers what an
 * agent asks on it (`answers`): the person the agent works for, or, when
 * its owner says so, always the owner. A space's `default` desk is the one
 * agents use when it has several.
 *
 * Its computer's name, whether it's online, and what it is are kept here
 * too, for the space's members: the computer itself is its owner's alone.
 */
import { defineCollection, type Infer, people } from "../../../../runtime/mod.ts";

const deskSchema = {
  type: "object",
  properties: {
    /** The space. */
    in: { type: "string" },
    computer: { type: "string" },
    /** Whose computer it is. */
    owner: { type: "string" },
    name: { type: "string" },
    online: { type: "boolean" },
    seen: { type: "string" },
    /** What the machine is (see Info): its system, root, browser. */
    info: { type: "object" },
    /** Its folder there, under the computer's root. */
    folder: { type: "string" },
    /** What its computer asks about, when it says (see computer.ts). */
    approve: { type: "array", items: { enum: ["terminal", "jobs", "writes"] } },
    /** What the app says of its computer, when it keeps it (see computer.ts). */
    status: {
      type: "object",
      properties: { kind: { type: "string" }, state: { type: "string" }, size: { type: "string" } },
      required: ["kind"],
    },
    /** Who answers what an agent asks here: whom it works for, or the owner. */
    answers: { type: "string", enum: ["asker", "owner"] },
    /** The one agents use, when the space has several. */
    default: { type: "boolean" },
    at: { type: "string" },
  },
  required: ["in", "computer", "owner", "folder", "online", "answers", "at"],
} as const;

export const desk = defineCollection({
  schema: deskSchema,
  indexes: [["in"], ["computer"]],
  queries: {
    /** A space's computers: its default first, then those online. */
    here: {
      allow: people,
      run: (desks, params: { in: string }) =>
        desks.find({ in: params.in }, { sort: { default: -1, online: -1, name: 1 } }),
    },
    /** Where one of the asker's computers works: its desks in the spaces they reach. */
    of: {
      allow: people,
      run: (desks, params: { computer: string }, ctx) =>
        desks.find({ computer: params.computer, owner: ctx.actor?.id ?? "" }, {
          sort: { at: 1 },
        }),
    },
  },
});

export type Desk = Infer<typeof deskSchema> & { _id: string };
