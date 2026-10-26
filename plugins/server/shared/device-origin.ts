/** Canonical HTTP(S) origins only; paths, credentials, wildcards and opaque origins are refused. */
export function validateAllowedOrigins(
  origins: readonly string[] = [],
): readonly string[] {
  if (!Array.isArray(origins)) {
    throw new TypeError("allowedOrigins must be an array");
  }
  return Object.freeze(origins.map((origin) => {
    if (typeof origin !== "string") {
      throw new TypeError("Invalid allowed origin");
    }
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) {
      throw new TypeError("allowedOrigins requires canonical HTTP(S) origins");
    }
    return origin;
  }));
}

/** undefined Origin permits header credentials only; false rejects before native upgrade. */
export function deviceOrigin(
  request: Request,
  allowedOrigins: readonly string[],
  publicHost?: string,
): "cookie" | "header" | false {
  const origin = request.headers.get("origin");
  if (origin === null) return "header";
  if (publicHost && /^[a-z0-9.-]+(:[0-9]{1,5})?$/i.test(publicHost)) {
    // The host a trusted edge forwarded; its https origin is this site.
    if (origin === new URL(`https://${publicHost}`).origin) return "cookie";
  }
  const own = new URL(request.url);
  // Behind a TLS-terminating edge the request arrives as http for the same
  // host; the https origin of that exact host is the same site, never foreign.
  const secure = own.protocol === "http:"
    ? new URL(`https://${own.host}`).origin
    : undefined;
  return origin === own.origin || origin === secure ||
      allowedOrigins.includes(origin)
    ? "cookie"
    : false;
}
