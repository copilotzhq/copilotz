/**
 * A computer program older than the app's release (the `downloads`
 * resource), and offering it the release: what `computer.ready` does as a
 * computer comes, what `computer.prepare` does before a plan's sign-in, and
 * what an app that hosts cloud computers does as a free VM of its pool
 * connects (its `pool.ready`: the `pool` kind serves `POOL.info` and
 * `POOL.update`, the same work), so the next computer woken on it runs the
 * app's release:
 *
 * ```ts
 * await offerUpdate(ctx, POOL_KIND, vm);
 * ```
 */
import type { Context } from "../../../../runtime/mod.ts";
import { binaryFor, newer, type Offer, UPDATE } from "../program/release.ts";
import type { Downloads } from "../resources/downloads.ts";
import { failed } from "./failed.ts";
import { type Failed, type Info, WORK } from "./workloads.ts";

/** What an offer needs of the machine: its platform, its program's version, what it serves. */
export type Running = Pick<Info, "os" | "arch" | "version" | "serves">;

/** Whether a program at `version` is older than the app's release (none to compare: it isn't). */
export function older(ctx: Pick<Context, "resources">, version: string | undefined): boolean {
  const release = ctx.resources.downloads as Downloads | undefined;
  return !!release && !!version && newer(release.manifest.version, version);
}

/**
 * Offers worker `id` of `kind` (`computer`, or a pool's) the app's release,
 * when it's newer than its program and has its platform's binary: as `info`
 * says, or as it says when asked (`computer.info`). The URL is as the
 * release has it: on the app's origin, the program resolves it there.
 * Whether it said it's updating; a program that doesn't take updates (run
 * from source, serving a computer from a pool) isn't asked, says no, or
 * fails, which is no too.
 */
export async function offerUpdate(
  ctx: Pick<Context, "resources" | "workers">,
  kind: string,
  id: string,
  info?: Running,
): Promise<boolean> {
  const release = ctx.resources.downloads as Downloads | undefined;
  if (!release) return false;
  const running = info ?? await ctx.workers.call<Info | Failed>(kind, id, WORK.info, {})
    .then((said) => failed(said) ? undefined : said as Info, () => undefined);
  if (!running?.version || !older(ctx, running.version)) return false;
  // One that says what it serves, and not updates (run from source), isn't asked: nothing would answer.
  if (running.serves && !running.serves.includes(UPDATE)) return false;
  const binary = binaryFor(release.manifest, running);
  if (!binary) return false;
  const answer = await ctx.workers.call<{ updating?: boolean }>(
    kind,
    id,
    UPDATE,
    {
      version: release.manifest.version,
      url: `${release.base}${binary.file}`,
      size: binary.size,
      sha256: binary.sha256,
    } satisfies Offer,
  ).catch(() => undefined);
  return answer?.updating === true;
}
