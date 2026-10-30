/**
 * Connecting an account: a sign-in started for a person (PKCE, and a state
 * kept as its hash, bound to them), and finished once, by them, with the
 * code the provider sent back: exchanged for tokens, the account written
 * with its renewal timer and `account.changed`, in one commit.
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { Account, Changed, Connecting, TokenAnswer } from "../contract.ts";
import type { AccountDoc } from "../collections/account.ts";
import type { Flow } from "../collections/flow.ts";
import { codeOf, invalid, refused } from "./errors.ts";
import {
  challenge,
  codeWord,
  digest,
  expiresOf,
  random,
  renewAt,
  signIn,
  tokens,
} from "./oauth.ts";
import { seal } from "./seal.ts";
import { accountId, providerOf, settingsOf, timerOf } from "./settings.ts";

/** How long a sign-in may take. */
const FLOW_MS = 10 * 60_000;

const iso = (ms: number) => new Date(ms).toISOString();

/** This app's callback for a provider: at its `accounts.url`, or the page's origin. */
function callbackOf(ctx: Context, name: string, origin?: string): string {
  const base = settingsOf(ctx).url ?? origin;
  let url: URL | undefined;
  try {
    url = base ? new URL(base) : undefined;
  } catch { /* said below */ }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw invalid(
      "Connecting needs the app's address: set `accounts.url`, or send the page's origin",
    );
  }
  return `${url.origin}/accounts/callback/${encodeURIComponent(name)}`;
}

/** Starts a person's sign-in at a provider: where to send them, and how they come back. */
export async function start(ctx: Context, name: string, origin?: string): Promise<Connecting> {
  const person = ctx.actor!.id;
  const provider = providerOf(ctx, name);
  const redirect = provider.oauth.redirect ?? callbackOf(ctx, name, origin);
  const state = random(32);
  const verifier = random(48);
  const flows = ctx.as().db.collection<Flow>("accountFlow");
  // One sign-in at a time: starting again leaves the one before nothing to finish.
  await flows.deleteMany({ person, provider: name });
  await flows.insertOne({
    _id: await digest(state),
    person,
    provider: name,
    verifier,
    redirect,
    expires: iso(Date.now() + FLOW_MS),
  });
  return {
    url: signIn(provider, { state, challenge: await challenge(verifier), redirect }),
    ...(provider.oauth.redirect ? { paste: provider.oauth.redirect } : {}),
  };
}

/** What the provider sent the person back with: a code and the state, or why not (`error`). */
export type Returned = { code?: string; state?: string; error?: string; at?: string };

/** An account as its person sees it: never its tokens. */
export const shown = (doc: AccountDoc): Account => {
  const { tokens: _, rev: __, ...rest } = doc;
  return rest as Account;
};

/**
 * Finishes the person's sign-in: their own, at this provider, in time, and
 * once. The code becomes tokens, and the account is written (connected
 * again, if it was before) with its renewal and `account.changed`.
 */
export async function finish(ctx: Context, name: string, returned: Returned): Promise<Account> {
  const person = ctx.actor!.id;
  const provider = providerOf(ctx, name);
  const flows = ctx.as().db.collection<Flow>("accountFlow");
  const flow = returned.state ? await flows.findOne({ _id: await digest(returned.state) }) : null;
  // Another person's, another provider's, or none at all: there's nothing to finish (and
  // nothing said about whose it was).
  if (!flow || flow.person !== person || flow.provider !== name) {
    throw invalid(`This ${provider.title} sign-in isn't one you started here: start again`);
  }
  // Used once, whatever happens next.
  await flows.deleteOne({ _id: flow._id });
  if (Date.parse(flow.expires) < Date.now()) {
    throw invalid(`This ${provider.title} sign-in took too long: start again`);
  }
  if (returned.at !== undefined && returned.at !== where(flow.redirect)) {
    throw invalid(`That isn't the address ${provider.title} sent you to: start again`);
  }
  if (returned.error) {
    throw refused(
      returned.error === "access_denied"
        ? `${provider.title} wasn't allowed: nothing was connected`
        : `${provider.title} didn't sign you in (${codeWord(returned.error) ?? "error"})`,
    );
  }
  if (!returned.code) throw invalid(`${provider.title} sent no sign-in code back: start again`);

  const answer = await tokens(provider, {
    grant_type: "authorization_code",
    code: returned.code,
    redirect_uri: flow.redirect,
    code_verifier: flow.verifier,
  }, ctx.signal);
  const profile = await profileOf(ctx, name, answer);
  const _id = accountId(person, name);
  const accounts = ctx.db.collection<AccountDoc>("account");
  const before = await accounts.findOne({ _id });
  const at = Date.now();
  const expires = expiresOf(answer, at);
  const doc = {
    person,
    provider: name,
    status: "connected" as const,
    label: profile.label,
    ...(profile.plan ? { plan: profile.plan } : {}),
    connected: iso(at),
    refreshed: iso(at),
    expires: iso(expires),
    rev: (before?.rev ?? 0) + 1,
    tokens: await seal(settingsOf(ctx).key, _id, {
      access: answer.access_token,
      ...(answer.refresh_token ? { refresh: answer.refresh_token } : {}),
      account: profile.id,
    }),
  };
  await ctx.transaction(async (tx) => {
    await tx.db.collection("account").replaceOne({ _id }, doc, { upsert: true });
    // Renewed before it runs out; one without a refresh token is good until then.
    if (answer.refresh_token) {
      tx.schedule("account.refresh", { account: _id }, {
        at: iso(renewAt(at, expires)),
        id: timerOf(_id),
      });
    } else tx.unschedule(timerOf(_id));
    tx.emit("account.changed", { _id, person, provider: name, status: "connected" } as Changed);
  });
  return shown({ _id, ...doc });
}

/** An address without its query: where a provider sends people back. */
export const where = (address: string) => {
  const url = new URL(address);
  return `${url.origin}${url.pathname}`;
};

/** Who the account is, from the token endpoint's answer, or why that can't be told. */
async function profileOf(ctx: Context, name: string, answer: TokenAnswer) {
  const provider = providerOf(ctx, name);
  try {
    const profile = await provider.profile(answer);
    if (!profile?.id) throw new Error("no id");
    return { ...profile, label: profile.label || `${provider.title} account` };
  } catch (error) {
    if (codeOf(error) === "account_unavailable") throw error;
    throw refused(`${provider.title} signed you in, but didn't say which account it is`);
  }
}
