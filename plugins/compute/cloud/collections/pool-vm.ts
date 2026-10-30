/**
 * VMs of the pools (`PoolVm`, the cloudPool plugin's), its `_id` the VM's
 * name, as they connect (the `pool` worker kind): free (connected, waiting
 * to serve a computer), assigned (taken for one, for one wake: it never
 * serves another; leased `until`), or gone (not connected: not yet, for a
 * while, or deleted). Only the system reads them.
 */
import { defineCollection } from "../../../../runtime/mod.ts";
import type { PoolVm } from "../contract.ts";

const poolVmSchema = {
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
    state: { type: "string", enum: ["free", "assigned", "gone"] },
    computer: { type: "string" },
    org: { type: "string" },
    at: { type: "string" },
    seen: { type: "string" },
    taken: { type: "string" },
    until: { type: "string" },
    released: { type: "string" },
  },
  required: ["placement", "size", "state", "at"],
} as const;

export const poolVm = defineCollection({
  schema: poolVmSchema,
  indexes: [["state", "size"], ["state", "until"]],
});

export type { PoolVm };
