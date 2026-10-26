import { digestContent } from "./digest.ts";
export type UnrecoverableLocation = Readonly<
  { namespace: string; backendId: string; key: string }
>;
export type UnrecoverableDecisions = Readonly<
  { entries: readonly UnrecoverableLocation[]; digest: string }
>;
export function unrecoverableIdentity(value: UnrecoverableLocation): string {
  return JSON.stringify([value.namespace, value.backendId, value.key]);
}
export async function unrecoverableDecisions(
  entries: readonly UnrecoverableLocation[],
): Promise<UnrecoverableDecisions> {
  if (!Array.isArray(entries)) {
    throw new TypeError("Unrecoverable entries must be an array.");
  }
  const seen = new Set<string>();
  const canonical = entries.map((entry) => {
    if (
      !entry ||
      Object.keys(entry).sort().join(",") !== "backendId,key,namespace" ||
      Object.values(entry).some((v) => typeof v !== "string" || !v.trim())
    ) {
      throw new TypeError(
        "Unrecoverable entries require exact namespace, backendId, key strings.",
      );
    }
    const key = unrecoverableIdentity(entry);
    if (seen.has(key)) throw new Error("Duplicate unrecoverable decision.");
    seen.add(key);
    return {
      namespace: entry.namespace,
      backendId: entry.backendId,
      key: entry.key,
    };
  }).sort((a, b) =>
    unrecoverableIdentity(a) < unrecoverableIdentity(b)
      ? -1
      : unrecoverableIdentity(a) > unrecoverableIdentity(b)
      ? 1
      : 0
  );
  return {
    entries: canonical,
    digest: await digestContent(
      new TextEncoder().encode(JSON.stringify(canonical)),
    ),
  };
}
export async function verifyUnrecoverableDecisions(
  value?: UnrecoverableDecisions,
) {
  if (value === undefined) return undefined;
  const canonical = await unrecoverableDecisions(value.entries);
  if (canonical.digest !== value.digest) {
    throw new Error("Unrecoverable decisions digest changed.");
  }
  return canonical;
}
export type ContentReference = Readonly<
  {
    kind: "node" | "event" | "stream";
    id: string;
    outcome: string;
    terminal: boolean;
  }
>;
export type MissingContent = UnrecoverableLocation & {
  references: readonly ContentReference[];
  eligible: boolean;
};
