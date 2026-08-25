/** Shared built-in provider endpoint normalization. @module */

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
