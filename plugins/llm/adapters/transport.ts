/** Join a construction-owned provider base URL with one fixed protocol path. */
export function providerEndpoint(
  baseUrl: string | undefined,
  fallbackBaseUrl: string,
  path: string,
): string {
  const base = typeof baseUrl === "string" && baseUrl.trim()
    ? baseUrl.trim()
    : fallbackBaseUrl;
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}
