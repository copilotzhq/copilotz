/**
 * `chat.unmark`: takes the old marks (`sources`) off every message, each
 * going where only those who could read it see it (see shared/unmark.ts):
 * its record of what it drew on (`drew`) in someone's Personal space, a
 * contact's chat's notes, the Personal space of the person it was for, or
 * held out of every space. It runs by itself once, as the runtime first
 * starts with it (chat's `chat.unmark` schedule: a deploy), and operators
 * call it (`POST /maintenance/actions/chat.unmark`), with `dryRun` to see
 * first what it would do: counts by kind, and every id it would touch.
 *
 * Safe to run again, and at once with the app's own traffic: a batch at a
 * time, each in one transaction (the moves, the threads they need, the
 * placeholders, and the counts of the chats they leave and join), as the
 * system; a message moved has no marks left, so a second run finds nothing.
 * An owner stopped mid-run runs it again when it starts.
 */
import { type Context, defineAction } from "../../../../runtime/mod.ts";
import type { Message } from "../collections/message.ts";
import { type Plan, type Reads, unmark } from "../shared/unmark.ts";
import { isMaintenance } from "../../../interfaces/maintenance/contract.ts";

/** The system's reads, as plain documents. */
const readsOf = (system: Context): Reads => ({
  find: async (collection, filter, options) =>
    await system.db.collection(collection).find(filter, options),
  findOne: (collection, filter) => system.db.collection(collection).findOne(filter),
});

/** A chat's summary (shared/summary.ts) as its messages now are: how many, its first and latest. */
async function summarized(tx: Pick<Context, "db">, thread: string) {
  const messages = tx.db.collection<Message>("message");
  const shared = { thread, private: { $ne: true } };
  const count = await messages.countDocuments(shared);
  const [first] = await messages.find(shared, { sort: { at: 1 }, limit: 1 });
  const [latest] = await messages.find(shared, { sort: { at: -1 }, limit: 1 });
  await tx.db.collection("thread").updateOne(
    { _id: thread },
    first && latest
      ? { $set: { messages: count, opened: first._id, latest: latest._id } }
      : { $set: { messages: 0 }, $unset: { opened: true, latest: true } },
  );
}

/** One batch, as planned: Personal spaces first, then everything else in one transaction. */
async function applied(system: Context, plan: Plan) {
  for (const person of plan.personal) {
    await system.as({ kind: "person", id: person }).call("space.personal", {});
  }
  const touched = new Set<string>();
  await system.transaction(async (tx) => {
    for (const thread of plan.threads) await tx.db.collection("thread").insertOne(thread);
    for (const step of plan.steps) {
      const m = step.message;
      const moved = step.thread
        ? { thread: step.thread, ...(typeof step.in === "string" ? { in: step.in } : {}) }
        : {};
      const set = { ...moved, ...(step.drew.length ? { drew: step.drew } : {}) };
      await tx.db.collection("message").updateOne({ _id: m._id, sources: { $exists: true } }, {
        ...(Object.keys(set).length ? { $set: set } : {}),
        $unset: {
          sources: true,
          ...(step.in === null ? { in: true } : {}),
          ...(step.drew.length ? {} : { drew: true }),
        },
      });
      // Its files go where it goes, or a contact would still read them in its chat.
      const files = (m.files ?? []).map((f) => f.id);
      if (step.thread && files.length) {
        await tx.db.collection("file").updateMany({ _id: { $in: files } }, {
          $set: moved,
          ...(step.in === null ? { $unset: { in: true } } : {}),
        });
      }
      if (step.placeholder) {
        await tx.db.collection("message").replaceOne(
          { _id: step.placeholder._id },
          step.placeholder,
          { upsert: true },
        );
      }
      if (step.thread) touched.add(m.thread).add(step.thread);
    }
    for (const thread of touched) await summarized(tx, thread);
  });
}

export const unmarkAction = defineAction({
  description:
    "Takes the old marks off messages: each goes where only those who could read it see it",
  input: {
    type: "object",
    properties: {
      /** Only reads, and says what it would do: counts by kind, and every id it would touch. */
      dryRun: { type: "boolean" },
      /** Messages a transaction moves (100). */
      batch: { type: "integer", minimum: 1, maximum: 500 },
    },
    additionalProperties: false,
  },
  allow: isMaintenance,
  run: async (ctx, input) => {
    const system = ctx.as();
    return await unmark(readsOf(system), {
      dryRun: input.dryRun === true,
      ...(input.batch ? { batch: input.batch } : {}),
      apply: (plan) => applied(system, plan),
      // On its own, on a deploy: it says what it did, and nothing when there was nothing to do.
      quiet: ctx.scheduled !== undefined,
    });
  },
});
