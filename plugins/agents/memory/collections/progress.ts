/** Messages each thread has shared since its last extraction. */
import { defineCollection } from "../../../../runtime/mod.ts";

const progressSchema = {
  type: "object",
  properties: { pending: { type: "array", items: { type: "string" } } },
  required: ["pending"],
} as const;

export const memoryProgress = defineCollection({ schema: progressSchema, events: false });
