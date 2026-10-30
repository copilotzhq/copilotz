/**
 * Renewing an account's tokens with its refresh token: on its timer, before
 * they run out, or as they're used when that didn't happen. One renewal at a
 * time per account in a process (the others wait for it: providers that
 * rotate refresh tokens refuse one used twice), and it writes only over the
 * tokens it read (`rev`), so a renewal elsewhere, a reconnect or a
 * disconnect is never undone.
 *
 * A provider that refuses the refresh token (expired, used, revoked) loses
 * the account: it needs signing in again, its tokens are dropped, and
 * `account.changed` says so. One that can't be reached loses nothing.
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { AccountProvider, Changed, Status } from "../contract.ts";
import type { AccountDoc } from "../collections/account.ts";
import { codeOf, lapsed, missing } from "./errors.ts";
import { expiresOf, renewAt, tokens } from "./oauth.ts";
import { seal, type Tokens, unseal } from "./seal.ts";
import { settingsOf, timerOf } from "./settings.ts";

const iso = (ms: number) => new Date(ms).toISOString();

const renewing = new Map<string, Promise<Tokens>>();

/** The account's tokens, renewed; `ctx` is the system's. */
export function renew(
  ctx: Context,
  account: AccountDoc,
  provider: AccountProvider,
): Promise<Tokens> {
  const running = renewing.get(account._id);
  if (running) return running;
  const work = once(ctx, account, provider).finally(() => renewing.delete(account._id));
  renewing.set(account._id, work);
  return work;
}

/** What a refusal means: the provider ended it (revoked), or it just needs signing in again. */
const lostAs = (oauth: string | undefined): Status =>
  /revoked|invalidated/.test(oauth ?? "") ? "revoked" : "needs_reconnect";

const PROBLEMS: Record<Status, string> = {
  connected: "",
  needs_reconnect: "Its sign-in ran out. Sign in again to keep using it.",
  revoked: "This sign-in was ended at the provider. Sign in again to use it.",
};

/** Marks an account lost (unless it changed meanwhile): no tokens, no timer, and it's said. */
export async function lose(ctx: Context, account: AccountDoc, status: Status, problem?: string) {
  await ctx.transaction(async (tx) => {
    const lost = await tx.db.collection("account").updateOne(
      { _id: account._id, rev: account.rev },
      { $set: { status, problem: problem ?? PROBLEMS[status] }, $unset: { tokens: "" } },
    );
    if (!lost.matchedCount) return;
    tx.unschedule(timerOf(account._id));
    tx.emit("account.changed", {
      _id: account._id,
      person: account.person,
      provider: account.provider,
      status,
    } as Changed);
  });
}

async function once(ctx: Context, account: AccountDoc, provider: AccountProvider): Promise<Tokens> {
  const { key } = settingsOf(ctx);
  const accounts = ctx.db.collection<AccountDoc>("account");
  const held = await unseal(key, account._id, account.tokens);
  if (!held.refresh) {
    await lose(ctx, account, "needs_reconnect");
    throw lapsed(`Your ${provider.title} sign-in ran out: reconnect it in Connected accounts`);
  }
  let answer;
  try {
    answer = await tokens(provider, { grant_type: "refresh_token", refresh_token: held.refresh });
  } catch (error) {
    if (codeOf(error) !== "account_refused") throw error;
    // Renewed elsewhere with the same refresh token first: its tokens stand.
    const now = await accounts.findOne({ _id: account._id });
    if (now?.status === "connected" && now.rev !== account.rev && now.tokens) {
      return await unseal(key, now._id, now.tokens);
    }
    const status = lostAs((error as { oauth?: string }).oauth);
    await lose(ctx, account, status);
    throw lapsed(
      `Your ${provider.title} account needs signing in again: reconnect it in Connected accounts`,
    );
  }
  const at = Date.now();
  const expires = expiresOf(answer, at);
  // A provider that doesn't rotate refresh tokens keeps the one it has.
  const next: Tokens = {
    access: answer.access_token,
    refresh: answer.refresh_token ?? held.refresh,
    account: held.account,
  };
  // What it says of the account may have changed (a new plan).
  const profile = answer.id_token
    ? await Promise.resolve(provider.profile(answer)).catch(() => undefined)
    : undefined;
  const written = await ctx.transaction(async (tx) => {
    const updated = await tx.db.collection("account").updateOne(
      { _id: account._id, rev: account.rev },
      {
        $set: {
          status: "connected",
          tokens: await seal(key, account._id, next),
          refreshed: iso(at),
          expires: iso(expires),
          ...(profile?.label ? { label: profile.label } : {}),
          ...(profile?.plan ? { plan: profile.plan } : {}),
        },
        $inc: { rev: 1 },
      },
    );
    if (updated.matchedCount) {
      tx.schedule("account.refresh", { account: account._id }, {
        at: iso(renewAt(at, expires)),
        id: timerOf(account._id),
      });
    }
    return updated.matchedCount;
  });
  if (written) return next;
  // Disconnected or reconnected while it renewed: what's there now stands.
  const now = await accounts.findOne({ _id: account._id });
  if (now?.status === "connected" && now.tokens) return await unseal(key, now._id, now.tokens);
  throw missing(`No ${provider.title} account is connected for this anymore`);
}
