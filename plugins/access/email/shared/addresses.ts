/**
 * Addresses as messages carry them: one alone (`ana@example.com`), or with a
 * name (`"Ana Lima <ana@example.com>"`). Who a message may be from is the
 * `email` resource's to say: its `from`, and its `senders` (addresses, or
 * `@domain` for every address there).
 */
import type { EmailSettings } from "../contract.ts";

/** The address alone, lowercased: what's between `<` and `>`, or the whole. */
export const addressOf = (text: string): string =>
  (/<([^<>]*)>\s*$/.exec(text)?.[1] ?? text).trim().toLowerCase();

/** The name with an address (`"Ana Lima"`), if it has one. */
export const nameOf = (text: string): string | undefined => {
  const at = text.lastIndexOf("<");
  const name = at > 0 ? text.slice(0, at).trim().replace(/^"(.*)"$/, "$1") : "";
  return name || undefined;
};

/** Whether a message may be from `from`: the app's `from`, or one of its `senders`. */
export function allowed(settings: EmailSettings, from: string): boolean {
  const address = addressOf(from);
  const allows = [...settings.from ? [settings.from] : [], ...settings.senders ?? []];
  return allows.some((one) =>
    one.trim().startsWith("@")
      ? address.endsWith(one.trim().toLowerCase())
      : addressOf(one) === address
  );
}
