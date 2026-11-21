/**
 * Jobs watched for their end (`computer.watch`): one an agent started in a
 * chat, for a person, its `_id` `<computer>:<job>`. When it ends, its agent
 * is told there, as that person (as a routine's message is theirs), and
 * takes a turn; the watch goes. Only the plugin's code reads them.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const watchSchema = {
  type: "object",
  properties: {
    computer: { type: "string" },
    /** The job's id on the computer, and what it's called (its name, else its command). */
    job: { type: "string" },
    name: { type: "string" },
    /** Where the job is on the computer: its space, folder and whose (`agent:<name>`). */
    scope: {
      type: "object",
      properties: {
        space: { type: "string" },
        folder: { type: "string" },
        who: { type: "string" },
      },
      required: ["space", "folder", "who"],
    },
    /** The chat it was started in (in space `in`), and the agent that started it. */
    thread: { type: "string" },
    in: { type: "string" },
    agent: { type: "string" },
    /** Whom the agent worked for; what set that work going (a routine), when something did. */
    person: { type: "string" },
    origin: { type: "object" },
    at: { type: "string" },
  },
  required: ["computer", "job", "name", "scope", "thread", "in", "agent", "person", "at"],
} as const;

export const jobWatch = defineCollection({ schema: watchSchema, indexes: [["computer"]] });

export type JobWatch = Infer<typeof watchSchema> & { _id: string };

/** A watch's id, and its timer's. */
export const watchOf = (computer: string, job: string) => `${computer}:${job}`;
export const watchTimer = (id: string) => `computer.watch:${id}`;
