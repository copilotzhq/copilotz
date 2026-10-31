/**
 * Wakes waiting for a VM (the cloudPool plugin's): a take that found none
 * free grew its pool by one, and waits for that VM. The pools are sized with
 * them counted (`pool.tick`), so a pool grown for a wake isn't shrunk again
 * before its VM connects. Each goes once its take ends. Only the system reads
 * them.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const poolWantSchema = {
  type: "object",
  properties: {
    placement: {
      type: "object",
      properties: {
        account: { type: "string" },
        project: { type: "string" },
        zone: { type: "string" },
      },
      required: ["project", "zone"],
    },
    size: { type: "string" },
    computer: { type: "string" },
    at: { type: "string" },
  },
  required: ["placement", "size", "computer", "at"],
} as const;

export const poolWant = defineCollection({ schema: poolWantSchema, indexes: [["at"]] });

export type PoolWant = Infer<typeof poolWantSchema> & { _id: string };
