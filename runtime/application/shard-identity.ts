export type ShardSessionKind = "worker" | "computer" | "browser" | "connector";
const PREFIX = "shard:";
/** Workers retain owner-issued IDs. All other kinds occupy disjoint reserved namespaces. */
export function shardSessionId(kind: ShardSessionKind, id: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id) || id.startsWith(PREFIX) ||
    (kind === "worker"
        ? id.length
        : id.length + PREFIX.length + kind.length + 1) > 128
  ) throw new TypeError("Invalid logical shard session ID");
  return kind === "worker" ? id : `${PREFIX}${kind}:${id}`;
}
export function shardSessionKind(id: string): ShardSessionKind | undefined {
  if (!id.startsWith(PREFIX)) return "worker";
  const match = /^shard:(computer|browser|connector):(.+)$/.exec(id);
  if (!match) return undefined;
  try {
    const decoded = match[2];
    return shardSessionId(match[1] as ShardSessionKind, decoded) === id
      ? match[1] as ShardSessionKind
      : undefined;
  } catch {
    return undefined;
  }
}
