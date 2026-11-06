/**
 * Codes and links' tokens, and what's kept of them: never themselves, only
 * an HMAC under a key derived from the app's secret (`links.secret`, its use
 * `email-sign-in`), over what each is for. A copy of the database alone
 * can't try the million six-digit codes against it. While the app changes
 * its secret, what the one before it sealed still matches.
 */
import { type Context, keyOf, type LinksSettings, secretsOf } from "../../../../runtime/mod.ts";
import type { Code } from "../collections/code.ts";
import { same } from "./password.ts";

/** How long a code works (minutes), and an invitation's link (hours). */
export const CODE_MINUTES = 15;
export const LINK_HOURS = 24;
/** Wrong tries at one code before it's spent. */
export const CODE_TRIES = 5;

const encoder = new TextEncoder();

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A six-digit code, each one as likely (no modulo bias), zero-padded. */
export function newCode(): string {
  const below = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  for (;;) {
    const [n] = crypto.getRandomValues(new Uint32Array(1));
    if (n < below) return String(n % 1_000_000).padStart(6, "0");
  }
}

/** A link's token, or an id no one guesses: random bytes (32 unless said), base64url. */
export const newToken = (bytes = 32): string =>
  base64url(crypto.getRandomValues(new Uint8Array(bytes)));

/** What's kept of a code or token (`text`: what it's for, then it), under one secret. */
async function sealUnder(secret: string, text: string): Promise<Uint8Array> {
  const key = await keyOf(secret, "email-sign-in");
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text)));
}

/** What's kept of a code or token, under the app's secret now. */
export const seal = async (links: LinksSettings, text: string): Promise<string> =>
  base64url(await sealUnder(links.secret, text));

/** What it may have been kept as: under the secret now, and the one before it. */
export const sealsOf = async (links: LinksSettings, text: string): Promise<string[]> =>
  await Promise.all(secretsOf(links).map(async (s) => base64url(await sealUnder(s, text))));

/** Whether a code is the one kept, under either secret; as long whatever the difference. */
export async function matches(links: LinksSettings, text: string, kept: string): Promise<boolean> {
  let ok = false;
  for (const sealed of await sealsOf(links, text)) {
    ok = same(encoder.encode(sealed), encoder.encode(kept)) || ok;
  }
  return ok;
}

/** What a code is sealed over: what it's for, whose address, and the code. */
export const codeText = (purpose: string, email: string, code: string): string =>
  `${purpose}\n${email}\n${code}`;

/** What an invitation's token is sealed over. */
export const tokenText = (token: string): string => `invite\n${token}`;

/**
 * A new code for something waiting (a sign-up's, a reset's): sealed onto its
 * record, its tries back to none, working for `CODE_MINUTES`. The code, to
 * send.
 */
export async function issue(
  ctx: Context,
  links: LinksSettings,
  waiting: Pick<Code, "_id" | "email" | "purpose">,
  now = Date.now(),
): Promise<string> {
  const code = newCode();
  await ctx.as().db.collection<Code>("email_code").updateOne({ _id: waiting._id }, {
    $set: {
      hash: await seal(links, codeText(waiting.purpose, waiting.email, code)),
      tries: 0,
      expires: new Date(now + CODE_MINUTES * 60_000).toISOString(),
    },
  });
  return code;
}

/**
 * What a code is for, among what waits for an address (`purpose`): the
 * record whose code it is, still working; else none, and every one of them
 * takes a wrong try, a code spent at `CODE_TRIES` (its seal goes: what
 * waited stays, for a new code).
 */
export async function redeem(
  ctx: Context,
  links: LinksSettings,
  purpose: Code["purpose"],
  email: string,
  code: string | undefined,
): Promise<Code | null> {
  const codes = ctx.as().db.collection<Code>("email_code");
  const now = new Date().toISOString();
  const live = await codes.find({
    email,
    purpose,
    hash: { $exists: true },
    expires: { $gt: now },
  }).toArray();
  for (const waiting of live) {
    if (code && await matches(links, codeText(purpose, email, code), waiting.hash!)) {
      return waiting;
    }
  }
  if (live.length) {
    await codes.updateMany({ email, purpose, hash: { $exists: true } }, { $inc: { tries: 1 } });
    await codes.updateMany(
      { email, purpose, tries: { $gte: CODE_TRIES } },
      { $unset: { hash: "" } },
    );
  }
  return null;
}
