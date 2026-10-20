/** Internal deterministic identity shared by capture creation and provenance checks. */
function cleanSegment(value: string) {
  return encodeURIComponent(value.trim()).replaceAll("%2F", "%252F");
}
export function contentStreamBodyId(
  namespace: string,
  id: string,
  prefix?: string,
) {
  return [
    ...(prefix?.split("/").map((s) => s.trim()).filter(Boolean) ?? []),
    "content-streams",
    cleanSegment(namespace),
    cleanSegment(id),
  ].join("/");
}

export function contentStreamIncarnationId(
  semanticId: string,
  incarnation?: string,
): string {
  return incarnation
    ? `incarnation:${encodeURIComponent(semanticId)}:${
      encodeURIComponent(incarnation)
    }`
    : semanticId;
}
