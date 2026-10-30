/**
 * Hosts orgs claimed (`abc123-preview.copilotz.app`, an app's own): the
 * orgs host serves a request to one with that org's routes, and the app's
 * front sends it straight to `target` when there's one (an app running
 * elsewhere: its Cloud Run URL). A host is one org's at a time.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const orgHostSchema = {
  type: "object",
  properties: {
    /** The org whose it is. */
    org: { type: "string" },
    /** Where the front sends its requests, rather than to the app. */
    target: { type: "string" },
    at: { type: "string" },
  },
  required: ["org", "at"],
} as const;

export const orgHost = defineCollection({
  schema: orgHostSchema,
  indexes: [["org"]],
  queries: {
    /** Whose a host is, and where its requests go: `{ org, target? }`, or null. The system's. */
    resolve: async (hosts, params: { host: string }) => {
      const found = await hosts.findOne({ _id: String(params.host ?? "").toLowerCase() });
      return found ? { org: found.org, ...(found.target ? { target: found.target } : {}) } : null;
    },
  },
});

export type OrgHost = Infer<typeof orgHostSchema> & { _id: string };
