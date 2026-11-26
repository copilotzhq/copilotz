/**
 * When notifications go: an agent asking a person's yes, and a message to
 * them, reach that person's devices, unless a tab of theirs shows the app
 * (said lately); never for their own message, an agent's private step, or a
 * message to nobody; and a tab that hid, or went quiet, no longer counts.
 */
import { assertEquals } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
} from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import { test } from "../../../../testing/mod.ts";
import { push, vapidKeys } from "../mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const keys = { p256dh: "BHxZ" + "A".repeat(83), auth: "a".repeat(22) };

/** Chat's collections as far as notifications read them, and a way to write them. */
const chat = definePlugin({
  name: "chat-stand-in",
  collections: {
    message: defineCollection({ schema: { type: "object" } }),
    approval: defineCollection({ schema: { type: "object" } }),
  },
  actions: {
    "test.write": defineAction({
      input: {
        type: "object",
        properties: {
          collection: { type: "string" },
          doc: { type: "object", additionalProperties: true },
        },
        required: ["collection", "doc"],
      },
      allow: () => false,
      run: (ctx, input: { collection: string; doc: Record<string, unknown> }) =>
        ctx.db.collection(input.collection).insertOne({
          at: new Date().toISOString(),
          ...input.doc,
        }),
    }),
  },
});

async function setup(
  fn: (rt: Awaited<ReturnType<typeof createRuntime>>, sent: string[]) => Promise<void>,
) {
  const app = { ...await vapidKeys(), contact: "mailto:ops@example.com" };
  const sent: string[] = [];
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [push, chat, definePlugin({ name: "app", resources: { push: app } })],
    fetch: (url) => {
      sent.push(String(url));
      return Promise.resolve(new Response(null, { status: 201 }));
    },
  });
  try {
    // A real key's point is needed to encrypt to: make one.
    const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ]) as CryptoKeyPair;
    const point = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
    const p256dh = btoa(String.fromCharCode(...point)).replace(/\+/g, "-").replace(/\//g, "_")
      .replace(/=+$/, "");
    await rt.call("push.subscribe", {
      endpoint: "https://push.example.com/ana",
      keys: { ...keys, p256dh },
    }, { actor: ana });
    await fn(rt, sent);
  } finally {
    await rt.close();
  }
}

const write = async (
  rt: Awaited<ReturnType<typeof createRuntime>>,
  collection: string,
  doc: Record<string, unknown>,
) => {
  await rt.call("test.write", { collection, doc });
  await rt.idle();
};

test("an agent asking for her yes, and a message to her, reach her devices", async () => {
  await setup(async (rt, sent) => {
    await write(rt, "approval", { owner: "ana", agent: "north", thread: "t1", text: "run df -h" });
    assertEquals(sent.length, 1);
    await write(rt, "message", { thread: "t1", from: "north", to: ["ana"], text: "Done." });
    assertEquals(sent.length, 2);
  });
});

test("nothing for her own message, a private step, or a message to nobody", async () => {
  await setup(async (rt, sent) => {
    await write(rt, "message", { thread: "t1", from: "ana", to: ["ana"], text: "note to self" });
    await write(rt, "message", {
      thread: "t1",
      from: "north",
      to: ["ana"],
      text: "x",
      private: true,
    });
    await write(rt, "message", { thread: "t1", from: "north", to: [], text: "Done." });
    await write(rt, "message", { thread: "t1", from: "north", to: ["bob"], text: "Done." });
    assertEquals(sent, []);
  });
});

test("nothing while a tab of hers shows the app; again once it hides", async () => {
  await setup(async (rt, sent) => {
    await rt.call("push.looking", { tab: "tab-00000001", visible: true }, { actor: ana });
    await write(rt, "message", { thread: "t1", from: "north", to: ["ana"], text: "Done." });
    await write(rt, "approval", { owner: "ana", agent: "north", thread: "t1", text: "run ls" });
    assertEquals(sent, []);
    await rt.call("push.looking", { tab: "tab-00000001", visible: false }, { actor: ana });
    await write(rt, "message", { thread: "t1", from: "north", to: ["ana"], text: "Done." });
    assertEquals(sent.length, 1);
  });
});

test("an agent can't say she's looking, and nobody reads her tabs", async () => {
  await setup(async (rt) => {
    let refused = false;
    await rt.call("push.looking", { tab: "tab-00000001", visible: true }, {
      actor: { kind: "agent", id: "north", for: ana } as Actor,
    }).catch(() => refused = true);
    assertEquals(refused, true);
  });
});
