/**
 * Publishing: what a person (`app.publish`) and an agent (the `publish`
 * tool) both do once they may. It finds the space's computer, and what to
 * build from it: the job's port (else the ports it listens on, else the one
 * given) and its command. It records the app, building, under a free label
 * claimed at the directory, and has the scheduler build it now
 * (`app.build`), so the call answers at once with its address. Publishing a
 * name the space already has publishes a new revision of that app.
 */
import type { Context } from "../../../../runtime/mod.ts";
import { type Failed, type Job, WORK } from "../../computers/contract.ts";
import type { AppDoc } from "../collections/app.ts";
import type { Where } from "./archive.ts";
import { codeOf, failure } from "./errors.ts";
import { hostOf } from "./host.ts";
import { claimLabel, kept, slugOf } from "./label.ts";
import { settingsOf } from "./settings.ts";
import { mustOwnOr } from "../../../access/spaces/contract.ts";

export type PublishInput = {
  in: string;
  /** The space's computer (its desk there), when the person says which. */
  desk?: string;
  /** Or that computer by its name or id (an agent's choice). */
  computer?: string;
  name: string;
  job?: string;
  port?: number;
  path?: string;
};

export type Published = { app: string; url: string; status: AppDoc["status"] };

/** What an agent asks its person to publish, as they read it (and a yes this once covers). */
export const detailOf = (input: Omit<PublishInput, "in">) =>
  [
    `publish ${input.name}`,
    input.job ? `from job ${input.job}` : "",
    input.port ? `on port ${input.port}` : "",
    input.path ? `from ${input.path}` : "",
  ].filter(Boolean).join(" ");

/**
 * Where an app of this name in the space will be, as its person is asked: its
 * address, published already; else its name's, when nothing here has it (one
 * taken in another org gets a short suffix when it's published).
 */
export async function addressFor(
  ctx: Context,
  space: string,
  name: string,
): Promise<string | undefined> {
  const apps = ctx.as().db.collection<AppDoc>("app");
  const had = await apps.findOne({ space, name: name.trim(), status: { $ne: "removed" } });
  if (had) return had.url;
  const label = slugOf(name);
  if (!label || kept(label)) return undefined;
  if (await apps.findOne({ label, status: { $ne: "removed" } })) return undefined;
  return `https://${label}.${settingsOf(ctx).domain}`;
}

/** When the scheduler builds `app`: now, as a timer of its own (one per app). */
const buildNow = (app: string) => ({
  at: new Date().toISOString(),
  id: `app.build:${app}`,
  retries: 0,
});

/**
 * What the app is built from: the job's command, and the port given (else
 * the job's, else the first it listens on), on the space's computer.
 */
async function sourceOf(
  ctx: Context,
  where: Where,
  input: PublishInput,
): Promise<AppDoc["source"]> {
  let port = input.port;
  let command: string | undefined;
  if (input.job) {
    const jobs = await ctx.workers.call<Job[] | Failed>(
      "computer",
      where.computer,
      WORK.jobsList,
      { scope: where.scope, all: true },
    ).catch((error) => {
      throw codeOf(error) === "offline"
        ? failure("The space's computer is offline: start it again to publish from it.", "offline")
        : error;
    });
    if (!Array.isArray(jobs)) throw failure(jobs.error.message, jobs.error.code);
    const job = jobs.find((j) => j.id === input.job) ?? jobs.find((j) => j.name === input.job);
    if (!job) throw failure(`There's no job "${input.job}" in this space's folder.`, "invalid");
    port = input.port ?? job.port ?? job.ports?.[0];
    command = job.command;
  }
  if (!port) {
    throw failure(
      "Which port does it serve? Give its job (one serving a port) or the port.",
      "invalid",
    );
  }
  return {
    computer: where.computer,
    port,
    ...(input.path ? { path: input.path } : {}),
    ...(command ? { command } : {}),
    ...(input.job ? { job: input.job } : {}),
  };
}

/**
 * Publishes for `by` (the person; `who`: whose shell asks the computer,
 * `agent:<name>` or `person:<id>`). The caller has checked they may.
 */
/** A build costs: an org that can't spend (the `spending` resource) doesn't start one. Live apps stay. */
async function mayBuild(ctx: Context): Promise<void> {
  const check = (ctx.resources.spending as { check?: string } | undefined)?.check;
  if (!check) return;
  const verdict = await ctx.as().call<{ ok: boolean; why?: string; message?: string }>(check, {});
  if (!verdict.ok) {
    throw failure(verdict.message ?? "This org can't spend right now.", verdict.why ?? "credits");
  }
}

export async function publish(
  ctx: Context,
  input: PublishInput & { who: string; by: string },
): Promise<Published> {
  const name = input.name.trim();
  if (!name) throw failure("An app needs a name.", "invalid");
  // Nowhere to publish to fails now, not once it's building.
  hostOf(ctx);
  await mayBuild(ctx);
  const where = await ctx.as().call<Where>("computer.scope", {
    in: input.in,
    who: input.who,
    ...(input.desk ? { desk: input.desk } : {}),
    ...(input.computer ? { computer: input.computer } : {}),
    // Else the computer running the job, whichever that is.
    ...(input.job ? { job: input.job } : {}),
  });
  const source = await sourceOf(ctx, where, input);
  const apps = ctx.as().db.collection<AppDoc>("app");
  const had = await apps.findOne({ space: input.in, name, status: { $ne: "removed" } });
  if (had) {
    await mustOwnOr(
      ctx,
      had.by,
      "manage",
      had.space,
      `${had.name} is someone else's: only who published it, or those who manage this space, can replace it.`,
    );
    return await rebuild(ctx, had, source);
  }
  const { domain } = settingsOf(ctx);
  const label = await claimLabel(ctx, name, domain);
  const id = crypto.randomUUID();
  const url = `https://${label}.${domain}`;
  await ctx.as().transaction(async (tx) => {
    await tx.db.collection<Omit<AppDoc, "_id"> & { _id: string }>("app").insertOne({
      _id: id,
      space: input.in,
      by: input.by,
      name,
      label,
      url,
      source,
      status: "building",
      at: new Date().toISOString(),
    });
    tx.schedule("app.build", { app: id }, buildNow(id));
  });
  return { app: id, url, status: "building" };
}

/** Builds an app again (a new revision), from its folder as it is now, or a new `source`. */
export async function rebuild(
  ctx: Context,
  app: AppDoc,
  source?: AppDoc["source"],
): Promise<Published> {
  if (app.status === "removed") {
    throw failure("It was removed: publish it again to bring it back.", "invalid");
  }
  if (app.status === "building") return { app: app._id, url: app.url, status: "building" };
  await mayBuild(ctx);
  await ctx.as().transaction(async (tx) => {
    await tx.db.collection("app").updateOne({ _id: app._id }, {
      $set: { status: "building", ...(source ? { source } : {}) },
      $unset: { error: "" },
    });
    tx.schedule("app.build", { app: app._id }, buildNow(app._id));
  });
  return { app: app._id, url: app.url, status: "building" };
}
