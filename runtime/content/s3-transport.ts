/** Strong object versions are the only acceptable ETag compare-and-swap values. */
export const parseStrongEtag = (value: string | null): string | undefined => {
  const etag = value?.trim();
  return etag && !etag.startsWith("W/") && /^"[^"\r\n]+"$/.test(etag)
    ? etag
    : undefined;
};
