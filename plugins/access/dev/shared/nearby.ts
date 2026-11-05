/**
 * Whether the app is somewhere public: the origin its `links` resource says
 * it's at (where its links and pages are), unless that's this machine or one
 * on its network (`localhost`, a `.local` name, a loopback, private or
 * link-local address: `privateAddress`). Dev sign-in doesn't start in one.
 */
import { privateAddress } from "../../../../runtime/mod.ts";

/** Whether a host name is this machine's or one on its network. */
const nearby = (hostname: string) => {
  const name = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local") ||
    privateAddress(name);
};

/** The app's public origin, if its `links` resource says it's somewhere public; else undefined. */
export function publicOrigin(resources: Record<string, unknown>): string | undefined {
  const origin = (resources.links as { origin?: unknown } | undefined)?.origin;
  if (typeof origin !== "string" || !origin) return undefined;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return origin;
  }
  return nearby(host) ? undefined : origin;
}
