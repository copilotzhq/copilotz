/**
 * A space's environment (`envVar`): variables and secrets its computers'
 * jobs and shells run with (those `computers` says), and its published apps
 * (all of them, and an app's own, `app`, over the space's). One per space,
 * app and name (`_id`: `<space>|<app>|<name>`). It lives in the space (the
 * `shared` resource: `space`): its members read names and the values of
 * variables; a secret's value is never read by anyone (a private field,
 * sealed with the `computers` resource's `key` when the app has one), only
 * its `hint` (its last characters, for a long one) shows it's there. Its
 * managers change it (`env.set`, `env.unset`). Queries: `here` (the
 * space's, or an app's with `app`) and `apps` (every app's own there).
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const envVarSchema = {
  type: "object",
  properties: {
    space: { type: "string" },
    /** An app's own (its id), over the space's; none: the space's. */
    app: { type: "string" },
    name: { type: "string" },
    /** A variable's value; a secret has none here. */
    value: { type: "string" },
    /** A secret's value, sealed (private: no one reads it but the plugin's Actions). */
    sealed: { type: "string" },
    secret: { type: "boolean" },
    /** Given to jobs and shells on the space's computers (not only to its apps). */
    computers: { type: "boolean" },
    /** A long secret's last characters (`••••1234`), to tell it apart. */
    hint: { type: "string" },
    by: { type: "string" },
    at: { type: "string" },
  },
  required: ["space", "name", "secret", "computers", "by", "at"],
} as const;

export const envVar = defineCollection({
  schema: envVarSchema,
  private: ["sealed"],
  indexes: [["space"]],
  queries: {
    /** A space's environment (its own, or an app's with `app`), by name. */
    here: {
      allow: (actor) => actor.kind === "person",
      run: (vars, params: { in: string; app?: string }) =>
        vars.find(
          { space: params.in, app: params.app ?? { $exists: false } },
          { sort: { name: 1 } },
        ),
    },
    /** Every app's own in a space (`app` says whose), by name. */
    apps: {
      allow: (actor) => actor.kind === "person",
      run: (vars, params: { in: string }) =>
        vars.find({ space: params.in, app: { $exists: true } }, { sort: { name: 1 } }),
    },
  },
});

export type EnvVar = Infer<typeof envVarSchema> & { _id: string };
