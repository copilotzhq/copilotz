/**
 * Previews of what a space's computer serves (see collections/preview.ts),
 * made by a person or, through the `preview` tool, by an agent for one:
 *
 * - `computer.preview` `{ in?, job?, port?, visibility? }`: the port a job
 *   serves (`port`; else the job's, or the first it listens on), on the
 *   space's computer (its desk there: one online first, as agents pick),
 *   at `https://<label>.<domain>/`. Where many orgs are served, the host is
 *   claimed for the org (its `directory` resource's `claimHost`), so its
 *   requests come here. Only who may work in the space makes one.
 * - `computer.previews` `{ in? }`: a space's previews, as the asker sees them.
 * - `computer.unpreview` `{ label }`: takes one away (whoever made it, or
 *   the space's managers).
 *
 * `in` is the space; a person's own Personal space when they give none.
 */
import { type Context, defineAction } from "../../../../runtime/mod.ts";
import type { Preview } from "../collections/preview.ts";
import { failed } from "../shared/failed.ts";
import { may, mustBeAble } from "../shared/desks.ts";
import { personOf } from "../shared/person.ts";
import { settingsOf } from "../shared/settings.ts";
import { desksIn } from "../shared/where.ts";
import { type Job, WORK } from "../shared/workloads.ts";

const fail = (message: string, code = "invalid") => Object.assign(new Error(message), { code });

/** The hosts an org claims, where many are served (the orgs host's `directory` resource). */
type Hosts = {
  claimHost?(host: string, claim?: { target?: string }): Promise<void>;
  releaseHost?(host: string): Promise<void>;
};
const hostsOf = (ctx: Context) => (ctx.resources.directory ?? {}) as Hosts;

/** Previews' settings, or why there are none. */
function previewsOf(ctx: Context) {
  const previews = settingsOf(ctx).previews;
  if (!previews) throw fail("This app doesn't serve previews (the computers resource's previews).");
  return previews;
}

/** How a host is reached: https, but plain http for development's `localhost`. */
export const schemeOf = (host: string): "http" | "https" =>
  /^(.+\.)?localhost(:\d+)?$/.test(host) ? "http" : "https";

/** A preview's address. */
export const previewUrl = (domain: string, label: string): string =>
  `${schemeOf(domain)}://${label}.${domain}/`;

/** A new preview's label: ten random letters and digits, then `-preview`. */
function newLabel() {
  const letters = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `${Array.from(bytes, (b) => letters[b % letters.length]).join("")}-preview`;
}

/** The space asked for: given, else the person's own (an agent always says which). */
async function spaceOf(ctx: Context, given: string | undefined) {
  if (given) return given;
  if (ctx.actor?.kind !== "person") throw fail("Which space?");
  return (await ctx.call<{ space: string }>("space.personal", {})).space;
}

const space = { type: "string" } as const;

export const previewAction = defineAction({
  description: "Makes an address for what a job on a space's computer serves",
  input: {
    type: "object",
    properties: {
      in: space,
      /** A job's id (or name), as the computer lists them: its port, unless `port` says. */
      job: { type: "string" },
      port: { type: "integer", minimum: 1, maximum: 65535 },
      visibility: { enum: ["members", "link"] },
    },
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const settings = previewsOf(ctx);
    const person = personOf(ctx.actor);
    if (!person) throw fail("A preview is made for a person.", "forbidden");
    const where = await spaceOf(ctx, input.in);
    await mustBeAble(ctx, where, "write");
    // As agents pick: one online first, else the space's own (asleep, it wakes when asked).
    const desks = await desksIn(ctx, where);
    const desk = desks.find((d) => d.online) ?? desks[0];
    if (!desk) throw fail("There's no computer in this space to preview.");
    let port = input.port;
    let who = ctx.actor?.kind === "agent" ? `agent:${ctx.actor.id}` : `person:${person}`;
    let job: Job | undefined;
    if (input.job) {
      if (!desk.online) {
        throw fail(`${desk.name ?? "This space's computer"} is offline: give the port instead.`);
      }
      const scope = { space: where, folder: desk.folder, who };
      const jobs = await ctx.workers.call<Job[]>("computer", desk.computer, WORK.jobsList, {
        scope,
        all: true,
      });
      const error = failed(jobs);
      if (error) throw error;
      job = jobs.find((j) => j.id === input.job) ?? jobs.find((j) => j.name === input.job);
      if (!job) throw fail(`There's no job "${input.job}" in this space.`, "not_found");
      who = job.who;
      port ??= job.port ?? job.ports?.[0];
    }
    if (!port) {
      throw fail(
        job
          ? `Job "${job.name}" says no port, and listens on none yet: which port does it serve?`
          : "Which port? Give the port it serves, or the job that serves it.",
      );
    }
    const label = newLabel();
    // Where many orgs are served, the host is the org's, so its requests reach this runtime.
    await hostsOf(ctx).claimHost?.(`${label}.${settings.domain}`);
    const made: Preview = {
      _id: label,
      computer: desk.computer,
      space: where,
      folder: desk.folder,
      who,
      port,
      ...(job ? { job: job.id } : {}),
      by: person,
      visibility: input.visibility ?? "members",
      at: new Date().toISOString(),
    };
    await ctx.as().db.collection<Preview>("preview").insertOne(made);
    return { url: previewUrl(settings.domain, label), label };
  },
});

export const previewsAction = defineAction({
  description: "A space's previews: what its computers serve, at addresses of their own",
  input: { type: "object", properties: { in: space }, additionalProperties: false },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const { domain } = previewsOf(ctx);
    // As the asker: the rules keep to the spaces they reach.
    const previews = await ctx.db.collection<Preview>("preview").find({
      space: await spaceOf(ctx, input.in),
    }, { sort: { at: -1 } });
    return { previews: previews.map((p) => ({ ...p, url: previewUrl(domain, p._id) })) };
  },
});

export const unpreviewAction = defineAction({
  description: "Takes a preview away: its address no longer opens",
  input: {
    type: "object",
    properties: { label: { type: "string" } },
    required: ["label"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const { domain } = previewsOf(ctx);
    const found = await ctx.db.collection<Preview>("preview").findOne({ _id: input.label });
    if (!found) throw fail("No such preview here.", "not_found");
    if (found.by !== personOf(ctx.actor) && !await may(ctx, found.space, "manage")) {
      throw fail("Only who made it, or those who manage this space, can.", "forbidden");
    }
    await ctx.as().db.collection("preview").deleteOne({ _id: found._id });
    await hostsOf(ctx).releaseHost?.(`${found._id}.${domain}`);
    return { removed: found._id };
  },
});
