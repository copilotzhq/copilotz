/**
 * Platform staff, by verified email: they enter any org, reaching all of it,
 * and what they do there is on its record as theirs. The `directory`
 * resource's `staff` list seeds them.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const staffSchema = {
  type: "object",
  properties: { at: { type: "string" } },
  required: ["at"],
} as const;

export const staff = defineCollection({ schema: staffSchema });

export type Staff = Infer<typeof staffSchema> & { _id: string };
