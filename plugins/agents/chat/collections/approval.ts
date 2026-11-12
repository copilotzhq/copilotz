/**
 * What an agent's work waits on a person's answer for: a command on a
 * computer, a post into a space not everyone of its own sees, its answer going
 * back where work was handed over from. Who answers (`owner`): the person
 * the agent works for (`for`), or whom the asking plugin says (a computer's
 * owner). They answer with `chat.approve`, only as the ask allows
 * (`answers`): what a kind of ask may be answered with is its asker's to
 * say (a share is never allowed always). Asked in an agent's turn, it's that
 * call's own (`call`), and the turn waits for the answer to its question.
 * What's asked about (`on`) is what a yes is for: a computer's desk; the
 * place a share goes. The plugin that asks adds what it needs of its own
 * (computers: `computer`).
 */
import { defineCollection, type Infer, people } from "../../../../runtime/mod.ts";

/**
 * Every answer there is: yes this once, in this conversation, whenever what
 * set it going runs (`origin`), always, or no; and, for an answer handed
 * back, post it here, or send it to the asker alone.
 */
export const ANSWERS = ["once", "thread", "origin", "always", "deny", "here", "me"] as const;
export type Answer = typeof ANSWERS[number];

const approvalSchema = {
  type: "object",
  properties: {
    /** Who answers. */
    owner: { type: "string" },
    /** Whom the agent works for. */
    for: { type: "string" },
    agent: { type: "string" },
    /** The conversation it's asked in, where it shows. */
    thread: { type: "string" },
    /** The thread's space, so it shows where the conversation does. */
    in: { type: "string" },
    /** What kind: a computer's `terminal`, `jobs`, `writes`, `publish`, `destroy`; a `share`; `back`. */
    work: { type: "string" },
    /** What a yes is for: a desk; a place (a space, a conversation: `thread:<id>`). */
    on: { type: "string" },
    /** What exactly: the command, the file; where it'd go. A yes once is for this. */
    detail: { type: "string" },
    /** What it would do, as its person reads it: "run df -h", "post this to Launch". */
    text: { type: "string" },
    /** What a yes beyond this once lets: "run commands on laptop", "post to Launch". */
    covers: { type: "string" },
    /** Where, as it's shown: the computer's name; the place a share goes. */
    name: { type: "string" },
    /** How many people would see it (a share). */
    people: { type: "integer" },
    /** What it would write or say, shortly (a file's first lines, a change, a post). */
    preview: { type: "string" },
    /** The answers it takes, in the order they're offered. */
    answers: { type: "array", items: { enum: [...ANSWERS] } },
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
    /**
     * Asked in an agent's turn: the call that asked (its `callId`: it runs again as itself once
     * answered), and its question, the agent's message the answer replies to.
     */
    call: { type: "string" },
    question: { type: "string" },
    /** An answer handed back (`back`): the answer, where it was written, waiting to go. */
    reply: { type: "string" },
    status: { type: "string", enum: ["pending", "allowed", "denied"] },
    /** How it was answered. */
    grant: { enum: [...ANSWERS] },
    at: { type: "string" },
    decided: { type: "string" },
  },
  required: [
    "owner",
    "for",
    "thread",
    "agent",
    "work",
    "on",
    "detail",
    "answers",
    "status",
    "at",
  ],
} as const;

export const approval = defineCollection({
  schema: approvalSchema,
  indexes: [["owner", "status"], ["thread", "at"], ["call"], ["on"]],
  queries: {
    /** What agents wait on the asker for, oldest first. */
    pending: {
      allow: people,
      run: (approvals) => approvals.find({ status: "pending" }, { sort: { at: 1 } }),
    },
  },
});

export type Approval = Infer<typeof approvalSchema> & { _id: string };

/** The fields every ask has; anything else on one is its asking plugin's own. */
export const ASKED = new Set(["_id", ...Object.keys(approvalSchema.properties)]);
