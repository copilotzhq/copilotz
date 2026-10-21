/** Private backend facts retained by package-owned snapshot capability wrappers. */
type Capability = NonNullable<
  import("./session.ts").SqlSession["withReadSnapshot"]
>;
const exclusive = new WeakMap<Capability, () => boolean>();

export function markExclusiveReadSnapshot(capability: Capability): void {
  exclusive.set(capability, () => true);
}

export function usesExclusiveReadSnapshot(capability?: Capability): boolean {
  return capability ? exclusive.get(capability)?.() === true : false;
}

export function retainReadSnapshotKind(
  target: Capability,
  source: Capability,
): void {
  const kind = exclusive.get(source);
  if (kind) exclusive.set(target, kind);
}

/** A recoverable database selects its current physical generation at admission. */
export function trackReadSnapshotKind(
  target: Capability,
  source: () => Capability | undefined,
): void {
  exclusive.set(target, () => usesExclusiveReadSnapshot(source()));
}
