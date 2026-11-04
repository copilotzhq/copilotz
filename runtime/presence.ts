/**
 * Which workers of plugins' kinds (computers…) are connected: by kind and id, the worker and
 * the connection it's on. A worker can move to a fresh connection while its old one is still
 * open (Oxian's handoff, before a connection's streams run out): the new one is ready first,
 * then the old one closes. That's no arrival and no departure, so its kind hears neither.
 */
export type Presence = ReturnType<typeof workerPresence>;

export function workerPresence() {
  const at = new Map<string, { workerId: string; connectionId: string }>();
  const key = (kind: string, id: string) => `${kind}\u0000${id}`;
  return {
    /** A worker's connection is ready. True when the worker is new here, not just moving. */
    arrived(kind: string, id: string, workerId: string, connectionId: string): boolean {
      const was = at.get(key(kind, id));
      at.set(key(kind, id), { workerId, connectionId });
      return was?.workerId !== workerId;
    },
    /** A worker's connection closed. True when it was the one it's on: the worker is gone. */
    left(kind: string, id: string, workerId: string, connectionId: string): boolean {
      const now = at.get(key(kind, id));
      if (now?.workerId !== workerId || now.connectionId !== connectionId) return false;
      at.delete(key(kind, id));
      return true;
    },
    /** The worker connected as `kind`/`id`, if one is. */
    workerOf: (kind: string, id: string): string | undefined => at.get(key(kind, id))?.workerId,
    /** Everyone connected, as `[kind, id]`. */
    all: (): [string, string][] => [...at.keys()].map((k) => k.split("\u0000") as [string, string]),
    clear: () => at.clear(),
  };
}
