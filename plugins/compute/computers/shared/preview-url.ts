/** Previews' addresses: `https://<label>.<domain>/` (plain http for development's `localhost`). */

/** How a host is reached: https, but plain http for development's `localhost`. */
export const schemeOf = (host: string): "http" | "https" =>
  /^(.+\.)?localhost(:\d+)?$/.test(host) ? "http" : "https";

/** A preview's address. */
export const previewUrl = (domain: string, label: string): string =>
  `${schemeOf(domain)}://${label}.${domain}/`;
