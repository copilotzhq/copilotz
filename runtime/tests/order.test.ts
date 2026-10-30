/**
 * Events committed out of their order: writes running together take their
 * numbers in one order and may commit in another (a PostgreSQL store's do).
 * A Processor still gets each one, however far its cursor moved meanwhile.
 */
import { assertEquals } from "@std/assert";
import { type Actor, createRuntime, definePlugin, type Event, type Store } from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { test } from "../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };

const bell = definePlugin({
  name: "bell",
  collections: { ring: { schema: { type: "object" } } },
  events: {
    "bell.rang": {
      schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
      allow: (actor) => actor.kind === "person",
    },
  },
  processors: {
    "bell.count": {
      on: "bell.rang",
      run: async (ctx, event) => {
        await ctx.db.collection("ring").insertOne({ n: event.data.n });
      },
    },
  },
});

/**
 * A store whose next write with events, once `hold()` is called, answers
 * only after the one after it has (and its Processor had time to finish).
 */
function reordering(store: Store): Store & { hold(): void } {
  let holding = false;
  let release: (() => void) | undefined;
  const ordered = async <R extends { events: Event[] }>(run: Promise<R>, hold: boolean) => {
    const done = await run;
    if (!done.events.length) return done;
    if (hold) await new Promise<void>((resolve) => release = resolve);
    else if (release) {
      const go = release;
      release = undefined;
      setTimeout(go, 200);
    }
    return done;
  };
  const take = () => {
    const hold = holding;
    holding = false;
    return hold;
  };
  return {
    ...store,
    hold: () => void (holding = true),
    transaction: (epoch, work, options) => ordered(store.transaction(epoch, work, options), take()),
    ...(store.command
      ? {
        command: (epoch, command) => {
          const run = store.command!(epoch, command);
          return run && ordered(run, take());
        },
      }
      : {}),
  };
}

test("an event committed after one numbered later still reaches its Processor", async () => {
  const memory = memoryStore();
  const store = reordering(memory);
  const rt = await createRuntime({ store, plugins: [bell] });
  try {
    await rt.idle();
    store.hold();
    // The first answers last: its Processor's cursor is already past it.
    await Promise.all([
      rt.emit("bell.rang", { n: 1 }, { actor: ana }),
      rt.emit("bell.rang", { n: 2 }, { actor: ana }),
    ]);
    await rt.idle();
    const rings = await memory.find("ring");
    assertEquals(rings.map((r) => r.n).sort(), [1, 2]);
  } finally {
    await rt.close();
  }
});
