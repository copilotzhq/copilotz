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
): "cookie" | "header" | false {
  const origin = request.headers.get("origin");
  if (origin === null) return "header";
  return origin === new URL(request.url).origin ||
      allowedOrigins.includes(origin)
    ? "cookie"
    : false;
}
