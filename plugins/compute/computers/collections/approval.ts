/**
 * What an agent asked to do at a desk (a computer, in one space) and waits
 * for: a command, a job, a file write. Who answers (`owner`): the person the
 * agent works for (`for`), or the computer's owner when its desk says so;
 * they answer with `computer.approve`: yes once, yes for the conversation,
 * yes for the routine that set it going (`origin`), yes always, or no.
 */
import { defineCollection, type Infer, people } from "../../../../runtime/mod.ts";

const approvalSchema = {
  type: "object",
  properties: {
    /** Who answers. */
    owner: { type: "string" },
    /** Whom the agent works for. */
    for: { type: "string" },
    desk: { type: "string" },
    computer: { type: "string" },
    /** The computer's name, as it's shown. */
    name: { type: "string" },
    thread: { type: "string" },
    /** The thread's space, so it shows where the conversation does. */
    in: { type: "string" },
    agent: { type: "string" },
    /** What kind of work: `terminal`, `jobs`, `writes`. */
    work: { type: "string" },
    /** What exactly: the command, or the file. */
    detail: { type: "string" },
    /** For a write or an edit: what it would do, shortly (its first lines, or the change). */
    preview: { type: "string" },
    /** What set the agent going, when it wasn't a person there (chat's `Origin`). */
    origin: {
      type: "object",
      properties: {
        kind: { type: "string" },
        id: { type: "string" },
        name: { type: "string" },
        rev: { type: "integer" },
        path: { type: "string" },
      },
      required: ["kind", "id", "name", "rev"],
    },
    status: { type: "string", enum: ["pending", "allowed", "denied"] },
    /** How far a yes goes. */
    grant: { type: "string", enum: ["once", "thread", "origin", "always"] },
    at: { type: "string" },
    decided: { type: "string" },
  },
  required: [
    "owner",
    "for",
    "desk",
    "computer",
    "thread",
    "agent",
    "work",
    "detail",
    "status",
    "at",
  ],
} as const;

export const approval = defineCollection({
  schema: approvalSchema,
  indexes: [["owner", "status"], ["thread", "at"]],
  queries: {
    /** What agents wait on the asker for, oldest first. */
    pending: {
      allow: people,
      run: (approvals) => approvals.find({ status: "pending" }, { sort: { at: 1 } }),
    },
  },
});

export type Approval = Infer<typeof approvalSchema> & { _id: string };
