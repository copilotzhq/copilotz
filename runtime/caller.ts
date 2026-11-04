/**
 * Who's calling, as far as the network says: the caller's address, from the
 * header the app's front sets, believed only through the front. What a
 * plugin that limits callers by address reads them with (MCP's lines, the
 * contacts' web lines), each from its own settings (`CallerSettings`).
 *
 * - **With `front`** (the front's secret): a request without it came around
 *   the front, straight to the app: it's refused (`refused`).
 * - **With `hops`:** the entry that many from the end of the header's list,
 *   the one the app's own proxy appended.
 * - **An address that can't be read** (none, garbled, too few entries) is
 *   no address of its own: it's counted with every other such call, in one
 *   tight bucket (`unvouched`), never let through unlimited.
 * - **How it's counted:** an IPv4 address by itself (also written as IPv6,
 *   `::ffff:a.b.c.d`); an IPv6 address by its /64 (one customer's network
 *   has billions of addresses).
 * - **Exempt ranges** (a shared proxy's: OpenAI's) apply only to an address
 *   read this way, never to one the caller claims.
 *
 * Nothing here is kept: what limits count is the plugin's to keep.
 */

/**
 * Where a caller's address is, when the app's front says it: the header
 * the front sets (`cf-connecting-ip`; `x-forwarded-for`, a list), and why
 * it's believed. A header anyone may send is believed only from the front:
 *
 * - `front`: the front's secret, which it sends in `x-copilotz-front` (the
 *   web host's own front header). A request without it came around the
 *   front, straight to the app: it's refused.
 * - `hops`: for a list the app's own proxies append to (`x-forwarded-for`:
 *   Cloud Run's appends the address it saw), the entry that many from the
 *   end. A list header needs it: its first entries are the caller's to say.
 *
 * Callers in `exempt` (CIDR ranges: a shared proxy such as OpenAI's, every
 * ChatGPT user's calls behind a few addresses) aren't limited by address;
 * the plugin's other limits still hold. An address that can't be read is
 * counted with every other such call, as one caller. Without settings, no
 * limit goes by address.
 *
 * **To verify on each deployment** (a wrong setting lets callers choose
 * their address):
 * - with a Cloudflare worker as the front (`front`): that it sets
 *   `cf-connecting-ip` to the address Cloudflare saw, overwriting any the
 *   caller sent, and that it sends its secret only to the app;
 * - with `x-forwarded-for` (`hops`): how many proxies the app runs behind
 *   that each append to it (Cloud Run's front end: 1; a load balancer
 *   before it: 2). Too few hops counts a caller's own entry; too many, a
 *   proxy's address, every caller's.
 */
export type CallerSettings = { header: string; front?: string; hops?: number; exempt?: string[] };

/** The header the web host's front carries its secret in. */
const FRONT = "x-copilotz-front";

/** Headers that hold a list of addresses, each proxy appending its own: they need `hops`. */
const LISTS = ["x-forwarded-for"];

/** Who calls: refused (around the front), or what to count them by and whether they're exempt. */
export type Caller = "refused" | { counted: string; exempt: boolean };

/** Calls whose address can't be read, all counted as one. */
export const UNVOUCHED = "unvouched";

/** Whether two strings are the same, taking as long whatever their first difference. */
const same = (a: string, b: string) => {
  let differ = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    differ |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return differ === 0;
};

/** Who calls, by the app's `caller` settings; undefined without them (nothing goes by address). */
export function callerFrom(
  request: Request,
  caller: CallerSettings | undefined,
): Caller | undefined {
  if (!caller) return undefined;
  if (caller.front !== undefined) {
    const said = request.headers.get(FRONT);
    if (said === null || !same(said, caller.front)) return "refused";
  }
  const list = (request.headers.get(caller.header) ?? "").split(",").map((part) => part.trim())
    .filter(Boolean);
  const entry = caller.hops ? list.at(-caller.hops) : list.length === 1 ? list[0] : undefined;
  const at = entry ? addressOf(entry) : undefined;
  if (!at) return { counted: UNVOUCHED, exempt: false };
  return { counted: countOf(at), exempt: inRanges(at, caller.exempt) };
}

/** What an address is counted as: IPv4 by itself, IPv6 by its /64. */
const countOf = (at: Bits) =>
  at.size === 32 ? `4:${at.bits.toString(16)}` : `6:${(at.bits >> 64n).toString(16)}`;

/**
 * What an address the network gave (a socket's peer, as the listener saw it)
 * is counted as, as `callerFrom` counts a front's: IPv4 by itself, IPv6 by
 * its /64. Undefined when it isn't an address.
 */
export function countedOf(address: string): string | undefined {
  const at = addressOf(address.replace(/^\[|\]$/g, "").replace(/%.*$/, ""));
  return at ? countOf(at) : undefined;
}

type Bits = { bits: bigint; size: 32 | 128 };

/** An IPv4 address's 32 bits, from "a.b.c.d". */
function v4(text: string): bigint | undefined {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)?.slice(1).map(Number);
  if (!parts || parts.some((p) => p > 255)) return undefined;
  return parts.reduce((n, p) => (n << 8n) | BigInt(p), 0n);
}

/**
 * An address as bits: IPv4 in 32; IPv6 in 128, unless it's an IPv4 address
 * written as one (`::ffff:a.b.c.d`, `::ffff:cb00:7163`), which is IPv4.
 * Undefined when it isn't an address. A zone (`%eth0`) or brackets aren't taken.
 */
export function addressOf(text: string): Bits | undefined {
  const four = v4(text);
  if (four !== undefined) return { bits: four, size: 32 };
  if (!/^[0-9a-f:.]+$/i.test(text) || text.split("::").length > 2) return undefined;
  // A dotted IPv4 at the end, as its two groups.
  let written = text;
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const bits = v4(dotted[2]);
    if (bits === undefined) return undefined;
    written = `${dotted[1]}${(bits >> 16n).toString(16)}:${(bits & 0xffffn).toString(16)}`;
  }
  if (written.includes(".")) return undefined;
  const [head, tail] = written.includes("::") ? written.split("::") : [written, undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? left.length !== 8 : missing < 1) return undefined;
  const groups = [...left, ...Array(tail === undefined ? 0 : missing).fill("0"), ...right];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return undefined;
  const bits = groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g, 16)), 0n);
  // IPv4-mapped: ::ffff:0:0/96.
  if (bits >> 32n === 0xffffn) return { bits: bits & 0xffffffffn, size: 32 };
  return { bits, size: 128 };
}

/** A CIDR range (`192.0.2.0/24`, `2001:db8::/32`) as its bits and prefix; undefined when malformed. */
function rangeOf(text: string) {
  const [address, prefix, ...more] = text.split("/");
  const at = addressOf(address ?? "");
  const length = Number(prefix);
  if (!at || more.length || !/^\d{1,3}$/.test(prefix ?? "") || length > at.size) return undefined;
  return { ...at, length };
}

/** Whether `text` is a CIDR range. */
const rangeOk = (text: string): boolean => !!rangeOf(text);

/** Whether an address is in any of the ranges. */
function inRanges(at: Bits, ranges: string[] = []): boolean {
  return ranges.some((text) => {
    const range = rangeOf(text);
    if (!range || range.size !== at.size) return false;
    const shift = BigInt(at.size - range.length);
    return (at.bits >> shift) === (range.bits >> shift);
  });
}

/** What's wrong with how a plugin reads who's calling, if anything (checked when the app starts). */
export function callerProblem(caller: CallerSettings | undefined): string | undefined {
  if (!caller) return undefined;
  if (typeof caller.header !== "string" || !/^[a-z0-9-]{1,64}$/i.test(caller.header)) {
    return "caller.header is a header's name (cf-connecting-ip, x-forwarded-for)";
  }
  if (caller.front === undefined && caller.hops === undefined) {
    return "caller says why its header is believed: the front's secret (front), or hops";
  }
  if (
    caller.front !== undefined && (typeof caller.front !== "string" || caller.front.length < 16)
  ) {
    return "caller.front is the front's secret (16 characters at least)";
  }
  if (caller.hops !== undefined && !(Number.isInteger(caller.hops) && caller.hops > 0)) {
    return "caller.hops is a whole number over 0";
  }
  const header = caller.header.toLowerCase();
  if (header === "forwarded") return "caller.header: Forwarded isn't read (use x-forwarded-for)";
  if (LISTS.includes(header) && caller.hops === undefined) {
    return `caller.header ${header} is a list whose first entries the caller writes: say its hops`;
  }
  const bad = (caller.exempt ?? []).find((range) => !rangeOk(range));
  if (bad !== undefined) return `caller.exempt: "${bad}" isn't a CIDR range (192.0.2.0/24)`;
  return undefined;
}
