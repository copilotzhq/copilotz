/** Deterministic display identity: colors and initials for people, agents and Spaces. @module */

/** Mid-tone hues that carry white initials; one per identity, stable by id. */
export const identityPalette: readonly string[] = [
  "#4f46e5",
  "#7c3aed",
  "#db2777",
  "#d97706",
  "#059669",
  "#0284c7",
  "#e11d48",
  "#0d9488",
  "#ea580c",
  "#65a30d",
];

/** A stable palette color for an id (agent, Space or person). */
export function identityColor(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index++) {
    hash = ((hash << 5) - hash + id.charCodeAt(index)) | 0;
  }
  return identityPalette[Math.abs(hash) % identityPalette.length];
}

/** Up to two initials from a display name; `?` when there is nothing to show. */
export function initials(name: string | undefined): string {
  const words = (name ?? "").trim().split(/[\s._@-]+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
