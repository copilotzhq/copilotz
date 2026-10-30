/**
 * Where the app is, as its page says: its origin, and the path it's under
 * when a host serves many orgs (`/o/<org>`). For addresses the app shows to
 * be used without a browser's session: an API, a webhook, a computer.
 */
export function appBase(): string {
  const origin = globalThis.location?.origin ?? "";
  const config = globalThis.document?.getElementById("copilotz-config")?.textContent;
  try {
    const base = config ? (JSON.parse(config) as { base?: unknown }).base : undefined;
    return typeof base === "string" ? origin + base : origin;
  } catch {
    return origin;
  }
}
