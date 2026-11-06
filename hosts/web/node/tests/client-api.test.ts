/**
 * One script, either transport: a script connects to an app by its address
 * with a developer key, over the socket (a ticket from `POST /connect`) or
 * over HTTP (the REST API, a watch a server-sent stream), and the rest of it
 * is the same: it finds, writes, calls and watches a collection as the key's
 * person, within the key's space and scope. Served by `listen`, so it runs
 * on Node and Deno alike.
 */
import { assert, assertEquals } from "@std/assert";
import {
  type Actor,
  type Client,
  connect,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Runtime,
} from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import { access } from "../../../../plugins/access/mod.ts";
import { api } from "../../../../plugins/interfaces/api/mod.ts";
import { test } from "../../../../testing/mod.ts";
import { listen } from "../mod.ts";

const ana: Actor = { kind: "person", id: "ana" };

type Booking = { in: string; status: string; note?: string; seat?: number };

/** Bookings in spaces; one cancelled by its Action. */
const bookings = definePlugin({
  name: "bookings",
  collections: {
    booking: defineCollection({
      schema: {
        type: "object",
        properties: {
          in: { type: "string" },
          status: { type: "string", enum: ["open", "cancelled"] },
          note: { type: "string" },
          seat: { type: "number" },
        },
        required: ["in", "status"],
      },
    }),
  },
  actions: {
    "booking.cancel": defineAction({
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      allow: (actor) => actor.kind === "person",
      run: async (ctx, input) => {
        const { modifiedCount } = await ctx.db.collection("booking").updateOne(
          { _id: input.id },
          { $set: { status: "cancelled" } },
        );
        return { cancelled: modifiedCount };
      },
    }),
    // The system's: a test's bookings.
    "booking.seed": defineAction({
      input: { type: "object", properties: { docs: { type: "array" } }, required: ["docs"] },
      run: async (ctx, input) => {
        await ctx.db.collection("booking").insertMany(input.docs as (Booking & { _id: string })[]);
      },
    }),
    // What's there, as the system reads it.
    "booking.all": defineAction({
      input: { type: "object" },
      record: false,
      run: (ctx) => ctx.db.collection("booking").find({}, { sort: { _id: 1 } }),
    }),
  },
  resources: { shared: { booking: {} } },
});

/** Until `check` holds (what's pushed arrives on its own time). */
async function until(check: () => boolean, what: string, ms = 5_000) {
  for (let i = 0; i < ms / 10 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert(check(), what);
}

async function setup(
  fn: (s: { runtime: Runtime; base: string; key: string; space: string }) => Promise<void>,
) {
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [...access, api, bookings],
  });
  const server = await listen(runtime.fetch).catch(async (error) => {
    await runtime.close();
    throw error;
  });
  try {
    await runtime.call("person.set", { person: "ana", email: "ana@example.com" });
    const made = (name: string) =>
      runtime.call<{ space: string }>("space.create", { name }, { actor: ana });
    const [{ space }, { space: elsewhere }] = [await made("Trips"), await made("Elsewhere")];
    const { key } = await runtime.call<{ key: string }>("api_key.create", {
      in: space,
      name: "Script",
      scope: { read: ["booking"], write: ["booking"], call: ["booking.cancel"] },
    }, { actor: ana });
    // Three bookings where the key works, one elsewhere.
    await runtime.call("booking.seed", {
      docs: [
        { _id: "41", in: space, status: "open" },
        { _id: "42", in: space, status: "open" },
        { _id: "43", in: space, status: "cancelled" },
        { _id: "99", in: elsewhere, status: "open" },
      ],
    });
    await fn({ runtime, base: `http://127.0.0.1:${server.port}`, key, space });
  } finally {
    await server.shutdown();
    await runtime.close();
  }
}

for (const over of ["socket", "http"] as const) {
  test(`a script over ${over}: finds, writes, calls and watches, as its key`, async () => {
    await setup(async ({ runtime, base, key, space }) => {
      const app: Client = await connect(base, { key, over });
      try {
        const bookings = app.db.collection<Booking>("booking");
        // What it reaches: its space's, never elsewhere's.
        const open = await bookings.find({ status: "open" }, { sort: { _id: 1 } }).toArray();
        assertEquals(open.map((b) => b._id), ["41", "42"]);
        assertEquals(await bookings.countDocuments({}), 3);
        assertEquals((await bookings.findOne({ _id: "43" }))?.status, "cancelled");
        assertEquals(await bookings.findOne({ _id: "99" }), null);
        // It writes, as its person, where it works.
        const updated = await bookings.updateOne({ _id: "42" }, { $set: { note: "janela" } });
        assertEquals([updated.matchedCount, updated.modifiedCount], [1, 1]);
        const { insertedId } = await bookings.insertOne({ in: space, status: "open", seat: 7 });
        assertEquals((await bookings.findOne({ _id: insertedId }))?.seat, 7);
        assertEquals(
          (await bookings.replaceOne({ _id: insertedId }, { in: space, status: "open", seat: 8 }))
            .matchedCount,
          1,
        );
        // Not where it works: refused.
        const elsewhere = await bookings.insertOne({ in: "nowhere", status: "open" }).then(
          () => undefined,
          (error) => error,
        );
        assertEquals(elsewhere?.code, "forbidden");
        // It watches: the rows now, and after each change.
        const seen: string[][] = [];
        const stop = bookings.watch({ status: "open" }, { sort: { _id: 1 } }, (rows, error) => {
          assert(!error, String(error));
          seen.push(rows.map((b) => b._id));
        });
        await until(() => seen.length >= 1, "the rows now");
        // By `_id`: a new one's place among them is where its id sorts.
        assertEquals(seen[0], ["41", "42", insertedId].sort());
        // It calls an Action: what it changes shows in the watch.
        assertEquals(await app.call("booking.cancel", { id: "42" }), { cancelled: 1 });
        await until(() => seen.length >= 2, "the change");
        assertEquals(seen.at(-1), ["41", insertedId].sort());
        assertEquals((await bookings.deleteOne({ _id: insertedId })).deletedCount, 1);
        await until(() => seen.at(-1)?.length === 1, "the delete");
        stop();
        // Calls by its own id are done once.
        const first = await app.call("booking.cancel", { id: "41" }, { id: "cancel-41" });
        assertEquals(await app.call("booking.cancel", { id: "41" }, { id: "cancel-41" }), first);
        const all = await runtime.call<(Booking & { _id: string })[]>("booking.all", {});
        assertEquals(all.find((b) => b._id === "42")?.note, "janela");
      } finally {
        await app.close();
      }
    });
  });
}

test("a script with a key that proves nobody isn't let in, over either transport", async () => {
  await setup(async ({ base }) => {
    const socket = await connect(base, { key: "cpz_nope" }).then(() => undefined, (e) => e);
    assert(socket instanceof Error);
    const http = await connect(base, { key: "cpz_nope", over: "http" });
    const refused = await http.db.collection("booking").find({}).toArray().then(
      () => undefined,
      (e) => e,
    );
    assertEquals(refused?.code, "unauthorized");
    await http.close();
  });
});
