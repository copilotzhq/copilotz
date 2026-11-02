/** Stripe's settings: the `stripe` resource, which an app patches. */
import type { Resources } from "../../../../runtime/mod.ts";

/** A Stripe account that sells: an org pays one of them. */
export type Seller = {
  /** The account's key (a restricted one), and what signs its webhooks. */
  key: string;
  webhookSecret: string;
  /** What it charges in, lowercase, and USD per unit of it, when it isn't USD. */
  currency: string;
  rate?: number;
  /** The billing countries it sells to (ISO, `BR`); none: anyone a seller doesn't name. */
  countries?: string[];
  /** The product credits are sold as, and each plan's price for a seat. */
  credits: string;
  prices: Record<string, string>;
  /** The customer portal's configuration; none: the account's default. */
  portal?: string;
};

export type StripeSettings = {
  /** The accounts, by name, and the one that sells unless a country says otherwise. */
  sellers: Record<string, Seller>;
  seller: string;
  /** The app's address, for coming back from checkout. */
  url: string;
  /** Real money: a test mode's customers and subscriptions don't carry over. */
  live?: boolean;
  /** Instead of the network, in tests. */
  fetch?: typeof fetch;
};

export const settingsOf = (ctx: { resources: Resources }): StripeSettings =>
  (ctx.resources.stripe ?? { sellers: {}, seller: "", url: "" }) as StripeSettings;

/** Who sells to an org: who it already pays; else who sells to its country; else the default. */
export function sellerFor(
  set: StripeSettings,
  had: string | undefined,
  country?: string,
): [string, Seller] | undefined {
  const named = (name: string): [string, Seller] | undefined =>
    set.sellers[name] ? [name, set.sellers[name]] : undefined;
  if (had) return named(had);
  const upper = country?.toUpperCase();
  const found = Object.entries(set.sellers).find(([, s]) => upper && s.countries?.includes(upper));
  return found ?? named(set.seller);
}
