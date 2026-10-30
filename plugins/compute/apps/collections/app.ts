/**
 * A published app (see contract.ts, `App`): what a job on a space's
 * computer serves, built from its folder and run on its own at
 * `https://<label>.<domain>`. It's in its space (`space`), whose members
 * read it (the `shared` resource); only the plugin's Actions change it, as
 * the system. Beyond the contract's fields it keeps its address (`url`),
 * the image it runs, each revision it went live with, since when it's live,
 * and up to when its use was metered.
 */
import { defineCollection } from "../../../../runtime/mod.ts";
import type { App } from "../contract.ts";

const appSchema = {
  type: "object",
  properties: {
    space: { type: "string" },
    /** Who published it: the person (an agent publishes for its person). */
    by: { type: "string" },
    name: { type: "string" },
    label: { type: "string" },
    url: { type: "string" },
    source: {
      type: "object",
      properties: {
        computer: { type: "string" },
        /** A folder under the space's folder; none: all of it. */
        path: { type: "string" },
        /** What runs it (its job's command), when it came from a job. */
        command: { type: "string" },
        port: { type: "integer" },
        job: { type: "string" },
      },
      required: ["computer", "port"],
    },
    status: { type: "string", enum: ["building", "live", "failed", "removed"] },
    service: { type: "string" },
    target: { type: "string" },
    revision: { type: "string" },
    image: { type: "string" },
    error: { type: "string" },
    /** Each revision it went live with, oldest first: `{ revision, image, at }`. */
    revisions: { type: "array", items: { type: "object" } },
    /** Since when it's live (its latest revision), and up to when its running was metered. */
    live: { type: "string" },
    metered: { type: "string" },
    at: { type: "string" },
  },
  required: ["space", "by", "name", "label", "url", "source", "status", "at"],
} as const;

export const app = defineCollection({
  schema: appSchema,
  indexes: [["space"], ["label"], ["status"]],
  queries: {
    /** A space's apps, newest first (those removed aren't). */
    here: {
      allow: (actor) => actor.kind === "person",
      run: (apps, params: { in: string }) =>
        apps.find({ space: params.in, status: { $ne: "removed" } }, { sort: { at: -1 } }),
    },
  },
});

export type Revision = { revision: string; image: string; at: string };

/** An app as the collection keeps it. */
export type AppDoc = App & {
  url: string;
  source: App["source"] & { job?: string };
  image?: string;
  revisions?: Revision[];
  live?: string;
  metered?: string;
};
