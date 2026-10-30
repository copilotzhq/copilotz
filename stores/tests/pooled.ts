/**
 * A Postgres store in a schema it shares with a busy neighbor: another
 * tenant whose documents have the same ids in the same collections, with
 * events (the same ids too), edges, vectors, blobs and positions. A store
 * that let either tenant reach the other's rows would answer differently from
 * the reference, so every conformance test also tests isolation.
 */
import { postgresPool, postgresStore } from "../sql/postgres/mod.ts";

type PostgresStore = Awaited<ReturnType<typeof postgresStore>>;

/** Ids the conformance tests use, in the collections they use. */
const IDS = ["a", "b", "c", "d", "e", "n1", "q", "p", "u", "r", "x", "y", "z", "fresh", "kept"];
const COLLECTIONS = ["things", "m", "notes", "message", "item", "plain"];

export const schemaName = () => `p_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

/**
 * Opens `tenant` in a fresh schema beside a neighbor (on PGlite in memory, or
 * a server's URL). Closing it drops both, the schema and the pool.
 */
export async function pooled(url: string, tenant = "t"): Promise<PostgresStore> {
  const pool = await postgresPool({ url, writes: 2, reads: 2 });
  const schema = schemaName();
  const neighbor = await postgresStore({ pool, schema, tenant: "neighbor" });
  const { epoch } = await neighbor.open();
  await neighbor.transaction(epoch, async (tx) => {
    for (const collection of COLLECTIONS) {
      await tx.insert(
        collection,
        IDS.map((_id) => ({
          _id,
          n: 1000,
          s: "neighbor",
          b: true,
          tags: ["neighbor"],
          at: "2030-01-01",
          text: "neighbor",
          kind: "new",
          tag: "neighbor",
        })),
      );
    }
    for (const id of ["a", "b", "c"]) {
      await tx.link({ from: id, type: "knows", to: "b", data: { neighbor: true } });
      await tx.link({ from: id, type: "owns", to: "c" });
      await tx.putVector({ collection: "item", doc: id, field: "embedding", embedding: [1, 0, 0] });
    }
    await tx.putBlob({ id: "sha256-neighbor", data: new Uint8Array([1, 2, 3]) });
    for (const type of ["a", "b", "kept", "never", "quoted", "things.created"]) {
      tx.emit({ type, data: { neighbor: true }, cause: "e1" });
    }
    tx.emit({ id: "e1", type: "a", data: { neighbor: true } });
  }, { positions: { a: 99, b: 99, "note.retrying": 99 } });
  const store = await postgresStore({ pool, schema, tenant });
  const drop = store.drop;
  const close = async () => {
    // The store's own rows go first, then the schema with the neighbor in it.
    await drop();
    await neighbor.drop();
    await pool.close();
  };
  return Object.assign(store, { close, drop: close });
}
