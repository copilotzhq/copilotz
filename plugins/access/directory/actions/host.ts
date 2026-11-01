/**
 * Hosts orgs claim (see collections/org-host.ts), as the orgs host asks for
 * an org's runtime (its `directory` resource's `claimHost`, `releaseHost`).
 * The system's: the host has checked the host isn't the app's own.
 *
 * - `host.claim` `{ org, host, target? }`: the host is the org's (again:
 *   its target changes); refused when it's another org's;
 * - `host.release` `{ org, host }`: it's no longer the org's (if it was).
 */
import { defineAction, forbidden } from "../../../../runtime/mod.ts";
import type { OrgHost } from "../collections/org-host.ts";

/** A host, as claims keep it: lowercase letters, digits, dots and hyphens, and a port maybe. */
const host = { type: "string", pattern: "^[a-z0-9.-]+(:[0-9]{1,5})?$", maxLength: 253 } as const;

export const claimHostAction = defineAction({
  description: "Makes a host an org's (its requests go to the org's routes, or to a target)",
  input: {
    type: "object",
    properties: { org: { type: "string" }, host, target: { type: "string" } },
    required: ["org", "host"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const hosts = ctx.db.collection<OrgHost>("orgHost");
    const had = await hosts.findOne({ _id: input.host });
    if (had && had.org !== input.org) throw forbidden(`${input.host} is another org's.`);
    if (had) {
      await hosts.updateOne({ _id: input.host }, {
        ...(input.target ? { $set: { target: input.target } } : { $unset: { target: "" } }),
      });
    } else {
      await hosts.insertOne({
        _id: input.host,
        org: input.org,
        ...(input.target ? { target: input.target } : {}),
        at: new Date().toISOString(),
      });
    }
    return { host: input.host, org: input.org, ...(input.target ? { target: input.target } : {}) };
  },
});

export const releaseHostAction = defineAction({
  description: "A host is no longer an org's",
  input: {
    type: "object",
    properties: { org: { type: "string" }, host },
    required: ["org", "host"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const gone = await ctx.db.collection("orgHost").deleteOne({ _id: input.host, org: input.org });
    return { released: gone.deletedCount > 0 };
  },
});
