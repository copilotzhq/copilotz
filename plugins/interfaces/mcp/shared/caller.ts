/**
 * Who's calling, as far as the network says: the caller's address, from
 * the header the app's front sets (see `McpCaller` in settings.ts), only
 * when the request shows it came through that front; and whether it's in a
 * range the app exempts (a shared proxy's: OpenAI's, for every ChatGPT
 * user). Nothing here is kept: limits count an HMAC of the address.
 */
import type { McpCaller } from "./settings.ts";

/** The header the web host's front carries its secret in. */
const FRONT = "x-copilotz-front";

/** Whether two strings are the same, taking as long whatever their first difference. */
const same = (a: string, b: string) => {
  let differ = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    differ |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return differ === 0;
};

/** The caller's address, when the front says it and the request shows it came through the front. */
export function addressOf(request: Request, caller: McpCaller | undefined): string | undefined {
  if (!caller) return undefined;
  if (caller.front !== undefined) {
    const said = request.headers.get(FRONT);
    if (said === null || !same(said, caller.front)) return undefined;
  }
  const value = request.headers.get(caller.header);
  if (!value) return undefined;
  const list = value.split(",").map((part) => part.trim()).filter(Boolean);
  const address = caller.hops ? list.at(-caller.hops) : list[0];
  return address && bitsOf(address) ? address.toLowerCase() : undefined;
}

/** An address as bits (IPv4 in 32, IPv6 in 128), or undefined when it isn't one. */
function bitsOf(address: string): { bits: bigint; size: 32 | 128 } | undefined {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((p) => p > 255)) return undefined;
    return { bits: parts.reduce((n, p) => (n << 8n) | BigInt(p), 0n), size: 32 };
  }
  if (!/^[0-9a-f:]+$/i.test(address) || address.split("::").length > 2) return undefined;
  const [head, tail] = address.includes("::") ? address.split("::") : [address, undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? left.length !== 8 : missing < 1) return undefined;
  const groups = [...left, ...Array(tail === undefined ? 0 : missing).fill("0"), ...right];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return undefined;
  return { bits: groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g, 16)), 0n), size: 128 };
}

/** A CIDR range (`192.0.2.0/24`, `2001:db8::/32`) as its bits and prefix; undefined when malformed. */
function rangeOf(text: string) {
  const [address, prefix, ...more] = text.split("/");
  const at = bitsOf(address ?? "");
  const length = Number(prefix);
  if (!at || more.length || !/^\d{1,3}$/.test(prefix ?? "") || length > at.size) return undefined;
  return { ...at, length };
}

/** Whether `text` is a CIDR range. */
export const rangeOk = (text: string): boolean => !!rangeOf(text);

/** Whether an address is in any of the ranges. */
export function inRanges(address: string, ranges: string[] = []): boolean {
  const at = bitsOf(address);
  if (!at) return false;
  return ranges.some((text) => {
    const range = rangeOf(text);
    if (!range || range.size !== at.size) return false;
    const shift = BigInt(at.size - range.length);
    return (at.bits >> shift) === (range.bits >> shift);
  });
}
