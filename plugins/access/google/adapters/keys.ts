/**
 * Google's signing keys (the `googleKeys` port): fetched from Google and
 * kept as long as its Cache-Control says. Tests and offline hosts replace
 * it with their own (`adapters: { googleKeys: { default: { keys } } }`).
 */
import type { Jwk } from "../shared/jwt.ts";

export type GoogleKeys = { keys(): Promise<Jwk[]> };

const CERTS = "https://www.googleapis.com/oauth2/v3/certs";

export function googleKeys(fetcher: typeof fetch = fetch): GoogleKeys {
  let kept: { keys: Jwk[]; until: number } | undefined;
  return {
    async keys() {
      if (kept && kept.until > Date.now()) return kept.keys;
      const response = await fetcher(CERTS);
      if (!response.ok) throw new Error(`Google's keys: HTTP ${response.status}`);
      const age = Number(/max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1]);
      const { keys } = await response.json() as { keys: Jwk[] };
      kept = { keys, until: Date.now() + (Number.isFinite(age) ? age * 1000 : 3_600_000) };
      return keys;
    },
  };
}
