/**
 * Which addresses a page may be fetched from. Anything that is this machine,
 * its network or a cloud's metadata service is refused: loopback, private
 * ranges, link-local (169.254.169.254), carrier-grade NAT, multicast and
 * reserved, in IPv4 and IPv6, and IPv4 written inside IPv6. The host is
 * resolved and every address it has must pass.
 */
import { failure } from "../../../../runtime/mod.ts";
import type { Resolve } from "../contract.ts";

/** The four bytes of a dotted IPv4, or undefined. */
function v4(text: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return undefined;
  const bytes = m.slice(1).map(Number);
  return bytes.every((b) => b < 256) ? bytes : undefined;
}

/** The sixteen bytes of an IPv6, or undefined. */
function v6(text: string): number[] | undefined {
  let t = text.toLowerCase().replace(/%.*$/, "");
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(t);
  if (tail) {
    const b = v4(tail[1]);
    if (!b) return undefined;
    t = t.slice(0, -tail[1].length) + ((b[0] << 8) | b[1]).toString(16) + ":" +
      ((b[2] << 8) | b[3]).toString(16);
  }
  const halves = t.split("::");
  if (halves.length > 2) return undefined;
  const group = (s: string) => s ? s.split(":") : [];
  const head = group(halves[0]), rest = halves.length === 2 ? group(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return undefined;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...rest];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 255);
  }
  return bytes;
}

function blockedV4([a, b, c]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19));
}

/** Whether an address (IPv4 or IPv6, as text) is one a page may not be fetched from. */
export function blocked(address: string): boolean {
  const plain = address.replace(/^\[|\]$/g, "");
  const four = v4(plain);
  if (four) return blockedV4(four);
  const six = v6(plain);
  if (!six) return true; // Not an address we can read: not one to trust.
  if (six.every((b) => b === 0)) return true; // ::
  if (six.slice(0, 15).every((b) => b === 0) && six[15] === 1) return true; // ::1
  // IPv4 inside IPv6: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d), NAT64 (64:ff9b::/96).
  const mapped = six.slice(0, 10).every((b) => b === 0) && six[10] === 255 && six[11] === 255;
  const compat = six.slice(0, 12).every((b) => b === 0);
  const nat64 = six[0] === 0 && six[1] === 0x64 && six[2] === 0xff && six[3] === 0x9b &&
    six.slice(4, 12).every((b) => b === 0);
  if (mapped || compat || nat64) return blockedV4(six.slice(12));
  if ((six[0] & 0xfe) === 0xfc) return true; // fc00::/7, unique local (AWS's fd00:ec2::254 too)
  if (six[0] === 0xfe && (six[1] & 0xc0) === 0x80) return true; // fe80::/10, link-local
  if (six[0] === 0xfe && (six[1] & 0xc0) === 0xc0) return true; // fec0::/10, site-local
  return six[0] === 0xff; // multicast
}

/** The platform's resolver (Deno, Node and Bun all have `node:dns`). */
const platform: Resolve = async (host) => {
  const { lookup } = await import("node:dns/promises");
  return (await lookup(host, { all: true })).map((a) => a.address);
};

const NAMES = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

/**
 * Throws unless every address of the URL's host is allowed. A literal address
 * is checked as written (the URL parser has already made `2130706433` into
 * `127.0.0.1`); a name is resolved, and one that doesn't resolve fails.
 */
export async function allowed(url: URL, resolve: Resolve = platform): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const refuse = () =>
    failure(
      "forbidden",
      `${url.hostname} is a private or internal address; pages there aren't read`,
    );
  if (v4(host) || host.includes(":")) {
    if (blocked(host)) throw refuse();
    return;
  }
  if (NAMES.test(host.replace(/\.$/, ""))) throw refuse();
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw failure("unreachable", `Couldn't find ${host}`);
  }
  if (!addresses.length) throw failure("unreachable", `Couldn't find ${host}`);
  if (addresses.some(blocked)) throw refuse();
}
