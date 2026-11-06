/**
 * How much one address, and one caller, may ask of email sign-in (the
 * `emailSignIn` resource's `limits`): messages sent to an address an hour
 * (`sends`), tries at an address's password, codes or links in 15 minutes
 * (`tries`), and everything one caller asks in 15 minutes (`address`, by
 * their network address as the route counted it: callers it couldn't tell
 * apart are one, `unknown`). Each is taken before what it limits is done, in one write
 * that counts only while there's room, so tries at once can't pass it; past
 * any, it's refused (`too_many`). A count is taken whether or not the
 * address has an account, so the refusal says nothing about that.
 */
import { type Context, failure } from "../../../../runtime/mod.ts";
import type { Rate } from "../collections/rate.ts";
import { signInOf } from "./settings.ts";

const HOUR = 3_600_000;
const QUARTER = 900_000;

/** How much, unless the app says. */
export const LIMITS = { sends: 5, tries: 10, address: 30 } as const;

const SAID = {
  sends: "We've sent several emails to this address. Wait a while, then try again.",
  tries: "Too many tries for this email. Wait 15 minutes, then try again.",
  address: "Too many tries from here. Wait 15 minutes, then try again.",
} as const;

type Kind = keyof typeof SAID;

/** Who asks: the address it's about, and the caller, as the route counted them. */
export type Asker = { email?: string; address?: string };

/** Takes one of a counter's room in its window, or refuses (`too_many`) when there's none. */
async function take(ctx: Context, kind: Kind, whose: string, now: number): Promise<void> {
  const most = signInOf(ctx).limits?.[kind] ?? LIMITS[kind];
  const window = kind === "sends" ? HOUR : QUARTER;
  const start = Math.floor(now / window) * window;
  const rates = ctx.as().db.collection<Rate>("email_rate");
  try {
    await rates.updateOne(
      { _id: `${kind}|${whose}@${start}`, count: { $lt: most } },
      { $inc: { count: 1 }, $set: { until: start + window } },
      { upsert: true },
    );
  } catch (error) {
    // Full: the counter is there, past the filter, so the upsert finds its id taken.
    if ((error as { code?: string }).code !== "duplicate_key") throw error;
    throw failure("too_many", SAID[kind], { public: true });
  }
}

/**
 * A try at a password, a code or a link: the caller's (when the route says
 * who calls: trusted code that calls the Action itself isn't counted by
 * address), and the address's.
 */
export async function aTry(ctx: Context, asker: Asker, now = Date.now()): Promise<void> {
  if (asker.address) await take(ctx, "address", asker.address, now);
  if (asker.email) await take(ctx, "tries", asker.email, now);
}

/** A message asked for: the caller's, and the address's (of `sends` an hour). */
export async function aSend(ctx: Context, asker: Asker, now = Date.now()): Promise<void> {
  if (asker.address) await take(ctx, "address", asker.address, now);
  if (asker.email) await take(ctx, "sends", asker.email, now);
}
