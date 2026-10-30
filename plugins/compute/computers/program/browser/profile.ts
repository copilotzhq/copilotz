/**
 * A who's browser profile in a space: `<root>/.copilotz/browser/<folder>/<who>`,
 * `who` as a plain folder name, so its cookies, sign-ins and site storage
 * outlast its Chrome. Chrome keeps only cookies that expire; the session's
 * own, it drops when it stops. So that a sign-in lasts whatever kind it is,
 * they're kept when Chrome is stopped here (idle, a switch of window, the
 * program stopping), and given back to the next one on the profile.
 */
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DevTools } from "./cdp.ts";

/**
 * `who` as one plain folder name: lowercase letters, digits and dashes, then
 * a hash of it exactly, so no two (`person:Ana`, `person:ana`) share one,
 * even where file names ignore case. `agent:assistant` is
 * `agent-assistant-<hash>`.
 */
export function profileName(who: string): string {
  const plain = who.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 48).replace(/^-+|-+$/g, "");
  const hash = createHash("sha256").update(who).digest("hex").slice(0, 12);
  return `${plain || "who"}-${hash}`;
}

/** Where who's profile in a space's folder is, under the computer's root. */
export const profilePath = (root: string, folder: string, who: string): string =>
  join(root, ".copilotz", "browser", folder, profileName(who));

/** Session cookies kept between one Chrome on the profile and the next (readable only by its user). */
const KEPT = "copilotz-session-cookies.json";

type Cookie = Record<string, unknown> & { session?: boolean; partitionKeyOpaque?: boolean };

/** What `Storage.setCookies` takes of a cookie `Storage.getCookies` gave. */
const FIELDS = [
  "name",
  "value",
  "domain",
  "path",
  "secure",
  "httpOnly",
  "sameSite",
  "priority",
  "sourceScheme",
  "sourcePort",
  "partitionKey",
];

/** Keeps the session cookies of the Chrome `browser` drives, before it stops. */
export async function keepSessionCookies(browser: DevTools, profile: string, signal: AbortSignal) {
  const { cookies } = await browser.send<{ cookies: Cookie[] }>("Storage.getCookies", {}, signal);
  const kept = cookies.filter((cookie) => cookie.session && !cookie.partitionKeyOpaque)
    .map((cookie) =>
      Object.fromEntries(
        FIELDS.flatMap((key) => cookie[key] === undefined ? [] : [[key, cookie[key]]]),
      )
    );
  const path = join(profile, KEPT);
  if (!kept.length) return await rm(path, { force: true });
  await writeFile(path, JSON.stringify(kept), { mode: 0o600 });
}

/** Gives a new Chrome on the profile the session cookies kept from the last one. */
export async function restoreSessionCookies(
  browser: DevTools,
  profile: string,
  signal: AbortSignal,
) {
  const path = join(profile, KEPT);
  let cookies: unknown;
  try {
    cookies = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return;
  }
  if (Array.isArray(cookies) && cookies.length) {
    await browser.send("Storage.setCookies", { cookies }, signal).catch((error) => {
      // Kept for the next try if this one was cancelled; dropped if Chrome won't take them.
      if (signal.aborted) throw error;
    });
  }
  // Given back, they live in Chrome again (and are kept anew when it stops).
  await rm(path, { force: true });
}
