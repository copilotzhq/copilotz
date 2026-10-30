/**
 * What the accounts plugin reads of the configuration: its settings (the
 * `accounts` resource), its providers (`accountProviders`), and how
 * accounts and their timers are named.
 */
import type { Actor, Resources } from "../../../../runtime/mod.ts";
import type { AccountProvider } from "../contract.ts";
import { forbidden, invalid } from "./errors.ts";

/**
 * The `accounts` resource. `key` seals tokens at rest (any long secret,
 * from the app's own secrets); `url` is the app's address, for providers
 * that send people back to it (else the page's own).
 */
export type AccountsSettings = { key?: string; url?: string };

export const settingsOf = (ctx: { resources: Resources }): AccountsSettings =>
  (ctx.resources.accounts ?? {}) as AccountsSettings;

/** The providers declared, by name, without those taken away (`null`). */
export const providersOf = (ctx: { resources: Resources }): Record<string, AccountProvider> =>
  Object.fromEntries(
    Object.entries((ctx.resources.accountProviders ?? {}) as Record<string, AccountProvider | null>)
      .filter((entry): entry is [string, AccountProvider] => !!entry[1]),
  );

/** A provider by name, or why there's none. */
export function providerOf(ctx: { resources: Resources }, name: string): AccountProvider {
  const found = providersOf(ctx)[name];
  if (!found) throw invalid(`No account provider "${name}"`);
  return found;
}

/** A person's account at a provider: one each. */
export const accountId = (person: string, provider: string) => `${person}|${provider}`;

/** The timer that renews an account's tokens. */
export const timerOf = (account: string) => `account.refresh:${account}`;

/**
 * Whose account a call uses: the person acting (through any key or trusted
 * code acting as them), or the person an agent works for (`for`). The system
 * names one (`named`); anyone else has none. Naming someone else is refused.
 */
export function personFor(actor: Actor | undefined, named?: string): string | undefined {
  if (!actor || actor.kind === "system") return named;
  const who = actor.kind === "agent" ? actor.for as Actor | undefined : actor;
  const person = who?.kind === "person" ? who.id : undefined;
  if (named !== undefined && named !== person) {
    throw forbidden("Only the system asks for another person's account");
  }
  return person;
}
