/**
 * Publishing: what a person (`app.publish`) and an agent (the `publish`
 * tool) both do once they may. It finds the space's computer, and what to
 * build from it: the job's port (else the ports it listens on, else the one
 * given) and its command. It records the app, building, under a free label
 * claimed at the directory, and has the scheduler build it now
 * (`app.build`), so the call answers at once with its address. Publishing a
 * name the space already has publishes a new revision of that app.
 */
import type { Actor, Context } from "../../../../runtime/mod.ts";
import { type Failed, type Job, WORK } from "../../computers/contract.ts";
import type { AppDoc } from "../collections/app.ts";
import type { Where } from "./archive.ts";
import { codeOf, failure } from "./errors.ts";
import { hostOf } from "./host.ts";
import { claimLabel } from "./label.ts";
import { settingsOf } from "./settings.ts";

export type PublishInput = {
  in: string;
  name: string;
  job?: string;
  port?: number;
  path?: string;
};

export type Published = { app: string; url: string; status: AppDoc["status"] };

/** Whose work this is: the person acting, or whom an agent (`for`) or trusted code (`via`) acts for. */
export function personOf(actor: Actor | undefined): string | undefined {
  for (let a = actor, hops = 0; a && hops < 4; hops++) {
    if (a.kind === "person") return a.id;
    a = (a.for ?? a.via) as Actor | undefined;
  }
  return undefined;
}

/** Whether the caller may `verb` in `space`, as the spaces plugin says. */
export const can = async (ctx: Context, space: string, verb: "write" | "manage") =>
  (await ctx.call<{ can: boolean }>("space.can", { space, verb })).can;

/** What an agent asks its person to publish, as they read it (and a yes this once covers). */
export const detailOf = (input: Omit<PublishInput, "in">) =>
  [
    `publish ${input.name}`,
    input.job ? `from job ${input.job}` : "",
    input.port ? `on port ${input.port}` : "",
    input.path ? `from ${input.path}` : "",
  ].filter(Boolean).join(" ");

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
export async function publish(
  ctx: Context,
  input: PublishInput & { who: string; by: string },
): Promise<Published> {
  const name = input.name.trim();
  if (!name) throw failure("An app needs a name.", "invalid");
  // Nowhere to publish to fails now, not once it's building.
  hostOf(ctx);
  const where = await ctx.as().call<Where>("computer.scope", { in: input.in, who: input.who });
  const source = await sourceOf(ctx, where, input);
  const apps = ctx.as().db.collection<AppDoc>("app");
  const had = await apps.findOne({ space: input.in, name, status: { $ne: "removed" } });
  if (had) return await rebuild(ctx, had, source);
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
  await ctx.as().transaction(async (tx) => {
    await tx.db.collection("app").updateOne({ _id: app._id }, {
      $set: { status: "building", ...(source ? { source } : {}) },
      $unset: { error: "" },
    });
    tx.schedule("app.build", { app: app._id }, buildNow(app._id));
  });
  return { app: app._id, url: app.url, status: "building" };
}
