/**
 * Previews: what a job on a space's computer serves (a port of its), at an
 * address of its own, `https://<_id>.<domain>/` (see resources/previews.ts).
 * Its id is its host's first label: ten random letters and digits, then
 * `-preview`. It lives in the space (the `shared` resource: `space`), whose
 * members see it, as they see its computers; `link` lets anyone with the
 * address open it, `members` only the space's members, signed in.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";
import { previewUrl } from "../shared/preview-url.ts";
import { settingsOf } from "../shared/settings.ts";

const previewSchema = {
  type: "object",
  properties: {
    computer: { type: "string" },
    space: { type: "string" },
    /** The computer's folder for the space, and whose jobs (`scope.who`) serve it. */
    folder: { type: "string" },
    who: { type: "string" },
    port: { type: "integer" },
    /** The job that serves it, when it was made from one. */
    job: { type: "string" },
    /** The person who made it (or whose agent did). */
    by: { type: "string" },
    visibility: { type: "string", enum: ["members", "link"] },
    at: { type: "string" },
  },
  required: ["computer", "space", "folder", "who", "port", "by", "visibility", "at"],
} as const;

export const preview = defineCollection({
  schema: previewSchema,
  indexes: [["space"], ["computer"]],
  queries: {
    /** A space's previews, the newest first, each with its address (`url`). */
    here: {
      allow: (actor) => actor.kind === "person",
      run: async (previews, params: { in: string }, ctx) => {
        const domain = settingsOf(ctx).previews?.domain;
        const found = await previews.find({ space: params.in }, { sort: { at: -1 } });
        return domain ? found.map((p) => ({ ...p, url: previewUrl(domain, p._id) })) : found;
      },
    },
    /**
     * A preview by its label, while its computer is still in its space (a
     * desk there): the web host's, as the system, for each request.
     */
    label: async (previews, params: { label: string }, ctx) => {
      const found = await previews.findOne({ _id: String(params.label ?? "") });
      if (!found) return null;
      const desk = await ctx.db.collection("desk").findOne({
        computer: found.computer,
        in: found.space,
      });
      return desk ? found : null;
    },
  },
});

export type Preview = Infer<typeof previewSchema> & {
  _id: string;
  /** Its address, as `preview.here` gives it. */
  url?: string;
};
