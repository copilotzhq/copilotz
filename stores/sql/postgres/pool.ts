/**
 * Connections to one PostgreSQL database (or one PGlite), shared by every
 * store a process opens on it: many tenants' stores, few connections.
 *
 * Two lanes, each an Ominipg session over its own pool of connections: the
 * one owners commit through (`writes`) and the one committed state is read
 * through (`reads`), so a burst of reads never holds up a commit, nor a burst
 * of commits the reads. A store takes a connection for each statement, or for
 * a transaction while it is open, and gives it back: an idle store holds
 * none, and a closed one none at all. Each lane opens connections as they are
 * needed, up to its size; beyond it, statements wait for one.
 *
 * PGlite is one engine in this process: both lanes are the same session, and
 * a read waits for an open transaction.
 */
import { Ominipg } from "@oxian/ominipg";
import { autoConfigure } from "@oxian/ominipg/auto";

export type PostgresPool = {
  /** Where it connects: a `postgres://` URL, or PGlite's `:memory:` or `file://…`. */
  readonly url: string;
  /** Whether it is a PostgreSQL server; else PGlite, in this process. */
  readonly server: boolean;
  /** Where owners commit. */
  readonly writes: Ominipg;
  /** Where committed state is read. */
  readonly reads: Ominipg;
  /** Closes every connection. The stores on it go first. */
  close(): Promise<void>;
};

/** Whether a URL names a PostgreSQL server (else PGlite). */
const isServer = (url: string) => /^postgres(ql)?:\/\//.test(url);

export async function postgresPool(options: {
  url: string;
  /** Connections for commits, shared by every owner on the pool. Default 8. */
  writes?: number;
  /** Connections for reads. Default 8. */
  reads?: number;
}): Promise<PostgresPool> {
  const server = isServer(options.url);
  // PGlite loads pgvector itself; a server needs it installed.
  const connect = (max: number) =>
    Ominipg.connect(
      autoConfigure({ url: options.url, pgliteExtensions: ["vector"], pgPoolMax: max }),
    );
  const writes = await connect(options.writes ?? 8);
  let reads = writes;
  if (server) {
    try {
      reads = await connect(options.reads ?? 8);
    } catch (error) {
      await writes.close();
      throw error;
    }
  }
  let closed: Promise<void> | undefined;
  return {
    url: options.url,
    server,
    writes,
    reads,
    close: () =>
      closed ??= (async () => {
        await writes.close();
        if (reads !== writes) await reads.close();
      })(),
  };
}
