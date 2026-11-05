/**
 * The in-memory store's own: what it costs to reach a document by its id
 * doesn't grow with the collection (the runtime's `durable: false`
 * collections, the web lines' counters among them, take a write per
 * arrival and per message), and the order it answers in is still the
 * reference's: the collection's, a document changed in place keeping its
 * place, one made in a transaction after all the committed ones.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { Doc, Store } from "../../runtime/store.ts";
import { memoryStore } from "../memory/mod.ts";
import { test } from "../../testing/mod.ts";

/** A store holding `size` documents in `c`, and its owner's epoch. */
async function filled(size: number): Promise<{ store: Store; epoch: number }> {
  const store = memoryStore();
  const { epoch } = await store.open();
  const docs: Doc[] = Array.from({ length: size }, (_, i) => ({ _id: `d${i}`, n: i, until: 0 }));
  await store.transaction(epoch, (tx) => tx.insert("c", docs));
  return { store, epoch };
}

/**
 * The best of three runs of `ops` reads and conditional upserts by id, each
 * its own transaction, as a web line's counter takes them.
 */
async function byId(size: number, ops: number): Promise<number> {
  const { store, epoch } = await filled(size);
  let best = Infinity;
  for (let round = 0; round < 3; round++) {
    const started = performance.now();
    for (let i = 0; i < ops; i++) {
      const id = `d${(i * 7919) % size}`;
      await store.findOne("c", { _id: id });
      await store.transaction(
        epoch,
        (tx) =>
          tx.update("c", { _id: `k${round}-${i}`, count: { $lt: 5 } }, {
            $inc: { count: 1 },
            $set: { until: i },
          }, { upsert: true }),
      );
    }
    best = Math.min(best, performance.now() - started);
  }
  await store.close();
  return best;
}

test("reaching a document by its id costs the same in a large collection as in a small one", async () => {
  const small = await byId(100, 100);
  const large = await byId(10_000, 100);
  console.log(
    `100 reads and upserts by id: ${small.toFixed(1)} ms at 100 docs, ${
      large.toFixed(1)
    } ms at 10,000`,
  );
  // A collection 100 times larger: by id, not by scanning (which was ~linear: about 100 times).
  assert(large < small * 10 + 50, `${large.toFixed(1)} ms against ${small.toFixed(1)} ms`);
});

test("by id or not, the memory store answers in the collection's order", async () => {
  const store = memoryStore();
  const { epoch } = await store.open();
  const ids = (docs: Doc[]) => docs.map((d) => d._id);
  await store.transaction(
    epoch,
    (tx) => tx.insert("c", ["a", "b", "c", "d", "e"].map((_id, n) => ({ _id, n }))),
  );
  // `$in` in another order: the collection's, unless sorted.
  assertEquals(ids(await store.find("c", { _id: { $in: ["e", "a", "c"] } })), ["a", "c", "e"]);
  assertEquals(
    ids(await store.find("c", { _id: { $in: ["e", "a", "c"] } }, { sort: { n: -1 } })),
    ["e", "c", "a"],
  );
  assertEquals(
    ids(await store.find("c", { _id: { $in: ["e", "a", "c"] } }, { limit: 1, skip: 1 })),
    [
      "c",
    ],
  );
  // A clause of `$and` naming the id, and the rest of the filter still holding.
  assertEquals(ids(await store.find("c", { $and: [{ _id: { $in: ["b", "d"] } }, { n: 3 }] })), [
    "d",
  ]);
  assertEquals(ids(await store.find("c", { _id: "b", n: 2 })), []);
  assertEquals(ids(await store.find("c", { _id: { $eq: "b" } })), ["b"]);
  // An id that isn't a string matches no document whose id is one.
  assertEquals(await store.find("c", { _id: 1 as unknown as string }), []);
  assertEquals(await store.find("c", { _id: { $in: [1, "a"] } as never }).then(ids), ["a"]);
  assertEquals(await store.count("c", { _id: { $in: ["a", "b", "zz"] } }), 2);
  assertEquals(await store.count("c", {}), 5);
  // A filter it can't run fails before reading anything, by id too.
  await assertRejects(() => store.find("c", { _id: { $bad: 1 } } as never));

  // In one transaction: changed in place keeps its place, deleted then made again too; new ones
  // come after every committed one, in the order they were made.
  const { result } = await store.transaction(epoch, async (tx) => {
    await tx.insert("c", [{ _id: "z", n: 9 }]);
    await tx.update("c", { _id: "b" }, { $set: { n: 20 } });
    await tx.delete("c", { _id: "c" });
    await tx.insert("c", [{ _id: "y", n: 8 }]);
    await tx.insert("c", [{ _id: "c", n: 30 }]);
    await tx.delete("c", { _id: "d" });
    return {
      all: ids(await tx.find("c", {})),
      some: ids(await tx.find("c", { _id: { $in: ["y", "c", "z", "d", "b"] } })),
      one: await tx.findOne("c", { _id: "c" }),
      gone: await tx.findOne("c", { _id: "d" }),
      counted: await tx.count("c", { _id: { $in: ["d", "y"] } }),
    };
  });
  assertEquals(result.all, ["a", "b", "c", "e", "z", "y"]);
  assertEquals(result.some, ["b", "c", "z", "y"]);
  assertEquals(result.one, { _id: "c", n: 30 });
  assertEquals(result.gone, null);
  assertEquals(result.counted, 1);
  // Committed, the same: a committed id made again in the transaction kept its place.
  assertEquals(ids(await store.find("c", {})), ["a", "b", "c", "e", "z", "y"]);
  assertEquals(ids(await store.find("c", { _id: { $in: ["y", "z", "c", "a"] } })), [
    "a",
    "c",
    "z",
    "y",
  ]);
  // Deleted and made again across commits: last.
  await store.transaction(epoch, (tx) => tx.delete("c", { _id: "a" }));
  await store.transaction(epoch, (tx) => tx.insert("c", [{ _id: "a", n: 1 }]));
  assertEquals(ids(await store.find("c", {})), ["b", "c", "e", "z", "y", "a"]);
  assertEquals(ids(await store.find("c", { _id: { $in: ["a", "b"] } })), ["b", "a"]);

  // What a read answers is a copy: changing it changes nothing stored.
  const read = (await store.findOne("c", { _id: "b" }))!;
  read.n = -1;
  assertEquals((await store.findOne("c", { _id: "b" }))!.n, 20);

  // An upsert by id whose filter doesn't match the document there: the id is taken.
  await assertRejects(
    () =>
      store.transaction(
        epoch,
        (tx) => tx.update("c", { _id: "b", n: { $lt: 5 } }, { $set: { n: 1 } }, { upsert: true }),
      ),
    Error,
    "Duplicate",
  );
  await store.close();
});
