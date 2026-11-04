/**
 * A web visitor's secret: what their browser keeps (in an httpOnly cookie
 * the web host sets) and shows to be them. It stands on its own: signed with
 * the visitors' key of the app's secret (the `links` resource's, through
 * `keyOf`: never the secret itself, nor the key its links are signed with),
 * so nothing is kept when a page first comes in, and nobody without the
 * app's secret can make one.
 *
 * `vis_<line>.<id>.<issued>.<tags>.<mac>`: the line it came by, 128 random
 * bits, when it was made (ms, base 36), the tags of the networks it came from
 * (`<bits>-<hmac>`, narrowest first, `~` between, `-` for none: never the
 * address), and an HMAC of all of it. From it, through HMACs with the same
 * key, come the contact it is (`c-…`) and the contact's chat (`web-…`), the
 * same for as long as the secret lasts. A secret signed with the app's
 * previous secret (`links.previous`) is good too, and is the contact it was.
 */
import { keyOf } from "../../../../runtime/mod.ts";

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** HMAC-SHA256 of `parts` (kept apart as JSON) with the visitors' key of `secret`, in hex. */
const mac = async (secret: string, parts: unknown[]): Promise<string> =>
  hex(
    await crypto.subtle.sign(
      "HMAC",
      await keyOf(secret, "visitors"),
      encoder.encode(JSON.stringify(parts)),
    ),
  );

/** Whether two strings are the same, taking as long whatever their first difference. */
const same = (a: string, b: string) => {
  let differ = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    differ |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return differ === 0;
};

/**
 * Where a secret is good: the app's secrets (its own first, then the one
 * before it), and the org it's for (with the orgs host).
 */
export type Keyring = { secrets: string[]; org?: string };

/** A visitor's secret, read: and which of the app's secrets signed it. */
export type Visit = { line: string; id: string; issued: number; tags: string[]; secret: string };

const TAG = /^\d{1,2}-[0-9a-f]{16}$/;
const SHAPE =
  /^vis_([\w-]{1,60})\.([A-Za-z0-9_-]{22})\.([0-9a-z]{1,12})\.(-|\d{1,2}-[0-9a-f]{16}(?:~\d{1,2}-[0-9a-f]{16}){0,3})\.([0-9a-f]{32})$/;

const signed = (ring: Keyring, secret: string, visit: Omit<Visit, "secret">) =>
  mac(secret, [
    "web",
    "visitor",
    ring.org ?? null,
    visit.line,
    visit.id,
    visit.issued,
    visit.tags,
  ]).then((m) => m.slice(0, 32));

/** A new secret, for a visitor coming in by `line` from the networks tagged `tags` (`tagsOf`). */
export async function newSecret(ring: Keyring, line: string, tags: string[]): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
  const visit = { line, id, issued: Date.now(), tags };
  const said = await signed(ring, ring.secrets[0], visit);
  return `vis_${line}.${id}.${visit.issued.toString(36)}.${tags.join("~") || "-"}.${said}`;
}

/** What a secret says, when the app made it; undefined for anything else (forged, garbled). */
export async function visitOf(ring: Keyring, secret: unknown): Promise<Visit | undefined> {
  if (typeof secret !== "string") return undefined;
  const found = SHAPE.exec(secret);
  if (!found) return undefined;
  const [, line, id, issued, tagged, said] = found;
  const tags = tagged === "-" ? [] : tagged.split("~");
  if (tags.some((tag) => !TAG.test(tag))) return undefined;
  const visit = { line, id, issued: parseInt(issued, 36), tags };
  for (const key of ring.secrets) {
    if (same(said, await signed(ring, key, visit))) return { ...visit, secret: key };
  }
  return undefined;
}

/** The contact a visit is: by the secret that signed it, so the one before it still is who it was. */
export const contactOf = async (ring: Keyring, visit: Visit): Promise<string> =>
  `c-${
    (await mac(visit.secret, ["web", "contact", ring.org ?? null, visit.line, visit.id])).slice(
      0,
      24,
    )
  }`;

/** A web visitor's chat, from its contact: the same however often it's asked for. */
export const chatOf = async (ring: Keyring, contact: string): Promise<string> =>
  `web-${(await mac(ring.secrets[0], ["web", "chat", ring.org ?? null, contact])).slice(0, 24)}`;

/**
 * What the networks an address is in (`networksOf`) are counted and kept as:
 * each a tag, its prefix's length and an HMAC of it (`64-3f…`), never the
 * address.
 */
export const tagsOf = (
  ring: Keyring,
  line: string,
  networks: { network: string; bits: number }[],
): Promise<string[]> =>
  Promise.all(
    networks.map(async ({ network, bits }) =>
      `${bits}-${
        (await mac(ring.secrets[0], ["web", "address", ring.org ?? null, line, network])).slice(
          0,
          16,
        )
      }`
    ),
  );
