/**
 * Accounts: one per person and provider. Who it is there (a label, a plan),
 * how it stands, when it was signed in and renewed; and its tokens, a
 * private field (sealed, with the app's key): no actor's read and no View
 * gets them, only the plugin's own Actions. Its changes record no events,
 * since a lifecycle event copies the whole document: `account.changed` says
 * what happened instead, with nothing secret in it. Each person reads only
 * their own (the plugin's rule).
 *
 * Queries, for people: `account.providers`, what can be connected and how;
 * `account.uses`, which of some models would run on the asker's accounts.
 */
import { defineCollection, type Infer, people, type ReadContext } from "../../../../runtime/mod.ts";
import type { ProviderShown, Uses, UsesParams } from "../contract.ts";
import { providersOf } from "../shared/settings.ts";
import { usesOf } from "../shared/uses.ts";

const accountSchema = {
  type: "object",
  properties: {
    person: { type: "string" },
    provider: { type: "string" },
    status: { enum: ["connected", "needs_reconnect", "revoked"] },
    label: { type: "string" },
    plan: { type: "string" },
    problem: { type: "string" },
    connected: { type: "string" },
    refreshed: { type: "string" },
    expires: { type: "string" },
    /** How many times its tokens were written: a renewal writes only over what it read. */
    rev: { type: "integer" },
  },
  required: ["person", "provider", "status", "label", "connected"],
} as const;

export const account = defineCollection({
  schema: accountSchema,
  events: false,
  private: ["tokens"],
  indexes: [["person"]],
  queries: {
    /** The providers people can connect, as the page shows them: never their clients' secrets. */
    providers: {
      allow: people,
      run: (_, __, ctx: ReadContext): ProviderShown[] =>
        Object.entries(providersOf(ctx)).map(([name, p]) => ({
          name,
          title: p.title,
          allows: p.allows,
          ...(p.note ? { note: p.note } : {}),
          ...(p.icon ? { icon: p.icon } : {}),
          ...(p.oauth.redirect ? { paste: p.oauth.redirect } : {}),
          ...(p.models?.length ? { models: p.models } : {}),
        })),
    },
    /** For each agent's model, the asker's account it would run on (or one to reconnect). */
    uses: {
      allow: people,
      run: async (accounts, params: UsesParams, ctx): Promise<Uses> =>
        usesOf(ctx, await accounts.find({ person: ctx.actor!.id }), params),
    },
  },
});

export type AccountDoc = Infer<typeof accountSchema> & {
  _id: string;
  tokens?: unknown;
};
