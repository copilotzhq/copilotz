/**
 * What agents asked at a computer, and what people let them do there, as
 * computers kept them before chat kept every ask: the same collections
 * (`approval`, `grant`), each document as chat keeps it now, meaning the
 * same. Its desk is what a yes is for (`on`); an ask says the answers it
 * takes (as a computer's always did: once, this conversation, the routine
 * that set it going, always, or no; publishing and destroying, once or
 * no) and its words. So a routine's standing yes, or an "always", still lets
 * what it let, and what waits is still answered on its card.
 *
 * Safe to run again, and alongside the app: only what's still kept the old
 * way (a `desk`) changes, each in one write. A dry run reads, says what it
 * would change, and writes nothing.
 */
import type { Context } from "../../../../runtime/mod.ts";
import { answersFor, wordsOf } from "./ask.ts";

type Kept = Record<string, unknown>;

/** What a run did, or would (`dryRun`): how many asks and yeses, and on a dry run which. */
export type Upgraded = {
  dryRun: boolean;
  approvals: number;
  grants: number;
  /** On a dry run: the ids it would change. */
  ids?: { approvals: string[]; grants: string[] };
};

/** The line a run logs: what it did, or would. */
export type UpgradeLog = {
  severity: "NOTICE";
  migration: "computer.upgradeAsks";
  dryRun: boolean;
  approvals: number;
  grants: number;
  at: string;
};

export async function upgradeAsks(
  ctx: Pick<Context, "as">,
  options: {
    dryRun?: boolean;
    log?: (line: UpgradeLog) => void;
    /** Not a word when there was nothing to do (on its own, on a deploy). */
    quiet?: boolean;
    now?: () => string;
  } = {},
): Promise<Upgraded> {
  const dryRun = options.dryRun === true;
  const { db } = ctx.as();
  const approvals = db.collection<Kept>("approval");
  const grants = db.collection<Kept>("grant");
  // Kept the old way: on a desk. Replaced only while it still is, so a second run changes nothing.
  const old = { desk: { $exists: true } };
  const ids = { approvals: [] as string[], grants: [] as string[] };
  for (const { _id, desk, ...asked } of await approvals.find(old)) {
    ids.approvals.push(String(_id));
    if (dryRun) continue;
    const work = String(asked.work ?? "");
    const words = wordsOf({
      work,
      detail: String(asked.detail ?? ""),
      ...(typeof asked.name === "string" ? { name: asked.name } : {}),
    });
    await approvals.replaceOne({ _id, ...old }, {
      ...words,
      ...asked,
      on: asked.on ?? desk,
      answers: asked.answers ?? answersFor(work, !!asked.origin),
    });
  }
  for (const { _id, desk, ...given } of await grants.find(old)) {
    ids.grants.push(String(_id));
    if (dryRun) continue;
    await grants.replaceOne({ _id, ...old }, { ...given, on: given.on ?? desk });
  }
  const done = { dryRun, approvals: ids.approvals.length, grants: ids.grants.length };
  const log = options.log ?? ((line: UpgradeLog) => console.log(JSON.stringify(line)));
  if (done.approvals || done.grants || !options.quiet) {
    log({
      severity: "NOTICE",
      migration: "computer.upgradeAsks",
      ...done,
      at: (options.now ?? (() => new Date().toISOString()))(),
    });
  }
  return dryRun ? { ...done, ids } : done;
}
