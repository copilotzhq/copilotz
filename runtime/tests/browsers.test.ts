/**
 * A browser's connection, across a reconnect: back on a new transport
 * connection before the old one is noticed gone, it keeps its new stream
 * (and its reads); only the connection that went closes what it opened.
 * How much one holds is bounded: connections per actor (refused at
 * admission), reads watched per connection (refused, the others kept), and
 * resume credentials per actor (the oldest dropped).
 */
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { type Actor, createRuntime, definePlugin } from "../mod.ts";
import { BROWSER, type BrowserLimits, createBrowsers, READ, UNWATCH } from "../browsers.ts";
import { connect } from "../client.ts";
import { decode, encode } from "../wire.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { test } from "../../testing/mod.ts";

/** Bytes as a stream, as a call's input or output comes. */
const stream = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start: (c) => (c.enqueue(bytes), c.close()),
  });

test("a browser back on a new connection keeps it when the old one is noticed gone", async () => {
  const browsers = createBrowsers({
    observers: {
      observe: () => {
        throw new Error("no reads here");
      },
    },
    ruled: () => Promise.resolve(true),
    askable: () => true,
    call: () => Promise.resolve(null),
    emit: () => Promise.resolve(),
    dispatch: () => new Promise(() => {}),
  });
  const ana = browsers.config({ kind: "person", id: "ana" });
  /** Whether the browser's calls are taken: its connection is open. */
  const open = async () => {
    const run = browsers.admit({
      workload: READ,
      definition: { providerId: BROWSER, workerId: "w1" },
    })!;
    const answer = await decode<{ value?: unknown; error?: { message: string } }>(
      stream(await run({ input: stream(encode({ reads: [] })) })),
    );
    return !answer.error;
  };
  browsers.ready("w1", ana, "first");
  assertEquals(await open(), true);
  // Back on a new connection; then the first one is noticed gone.
  browsers.ready("w1", ana, "second");
  browsers.gone("w1", "first");
  assertEquals(await open(), true);
  // The one it's on going closes it.
  browsers.gone("w1", "second");
  assertEquals(await open(), false);
});

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };

/** Browsers whose reads each answer what they asked for, at once. */
const reading = (limits: BrowserLimits) => {
  const browsers = createBrowsers({
    observers: {
      observe: (_medium, _view, remote) =>
        ({
          subscribe: (listener: () => void) => (queueMicrotask(listener), () => {}),
          get: () => ({ status: "ready" as const, value: remote }),
          close: () => {},
        }) as never,
    },
    ruled: () => Promise.resolve(true),
    askable: () => true,
    call: () => Promise.resolve(null),
    emit: () => Promise.resolve(),
    dispatch: () => new Promise(() => {}),
    limits,
  });
  /** What a browser on `workerId` is answered for a workload it asks. */
  const ask = async (workerId: string, workload: string, body: unknown) => {
    const run = browsers.admit({ workload, definition: { providerId: BROWSER, workerId } })!;
    return (await decode<{ value?: unknown; error?: { message: string } }>(
      stream(await run({ input: stream(encode(body)) })),
    )).value;
  };
  const read = (key: string) => ({ key, read: { collection: "note", query: "all", params: key } });
  return { browsers, ask, read };
};

test("a connection watches so many reads; past them one is refused, and the others keep working", async () => {
  const { browsers, ask, read } = reading({ watches: 3 });
  browsers.ready("w1", browsers.config(ana), "c1");
  const codes = (answers: unknown) =>
    (answers as { key: string; error?: { code: string } }[]).map((a) => a.error?.code ?? a.key);
  assertEquals(codes(await ask("w1", READ, { reads: ["a", "b", "c", "d"].map(read) })), [
    "a",
    "b",
    "c",
    "too_many",
  ]);
  // Asked again, a read watched already is the same one: it doesn't count twice.
  assertEquals(codes(await ask("w1", READ, { reads: [read("a"), read("e")] })), ["a", "too_many"]);
  // One no longer watched makes room.
  await ask("w1", UNWATCH, { keys: ["b"] });
  assertEquals(codes(await ask("w1", READ, { reads: [read("e")] })), ["e"]);
  // Another connection's are its own.
  browsers.ready("w2", browsers.config(ana), "c2");
  assertEquals(codes(await ask("w2", READ, { reads: ["a", "b", "c"].map(read) })), ["a", "b", "c"]);
  browsers.close();
});

test("an actor has so many connections; one back on a new connection is the same", () => {
  const { browsers } = reading({ sockets: 2 });
  browsers.ready("w1", browsers.config(ana), "c1");
  browsers.ready("w2", browsers.config(ana), "c2");
  const refused = assertThrows(() => browsers.room(ana, "w3")) as { code?: string };
  assertEquals(refused.code, "too_many");
  // Back on a new connection, a browser is the one it was; someone else is their own.
  browsers.room(ana, "w1");
  browsers.room(bob, "w9");
  // One going makes room.
  browsers.gone("w1", "c1");
  browsers.room(ana, "w3");
  browsers.close();
});

test("an actor's resume credentials: so many, the oldest dropped; all forgotten on close", () => {
  const { browsers } = reading({ resumes: 2 });
  const secret = (actor: Actor) => browsers.resume(actor).credential.capability;
  const [first, second, third] = [secret(ana), secret(ana), secret(ana)];
  const theirs = secret(bob);
  assertEquals(browsers.resumed(first), undefined);
  assertEquals([browsers.resumed(second), browsers.resumed(third)], [ana, ana]);
  assertEquals(browsers.resumed(theirs), bob);
  browsers.close();
  assertEquals(browsers.resumed(third), undefined);
});

test("the owner refuses an actor's seventeenth connection, and takes one when another goes", async () => {
  const topic = `browsers-test.${crypto.randomUUID()}`;
  const tickets = new Map<string, Actor>();
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [definePlugin({ name: "nothing" })],
    transports: [{ type: "in-process", config: { topic } }],
    admit: (secret) => {
      const actor = tickets.get(secret);
      tickets.delete(secret);
      return actor;
    },
  });
  const as = (actor: Actor) =>
    connect({
      transport: { type: "in-process", config: { topic } },
      ticket: () => {
        const secret = crypto.randomUUID();
        tickets.set(secret, actor);
        return Promise.resolve(secret);
      },
      plugins: [],
    });
  const clients = Array.from({ length: 16 }, () => as(ana));
  const more: ReturnType<typeof connect>[] = [];
  try {
    await Promise.all(clients.map((c) => c.ready));
    assertEquals(rt.stats().browsers, 16);
    more.push(as(ana));
    await assertRejects(() => more[0].ready);
    // Someone else still connects.
    more.push(as(bob));
    await more[1].ready;
    // One of hers going makes room for another.
    await clients.pop()!.close();
    for (let i = 0; i < 100 && rt.stats().browsers > 16; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    more.push(as(ana));
    await more[2].ready;
    assert(rt.stats().browsers <= 17);
  } finally {
    await Promise.all([...clients, ...more].map((c) => c.close().catch(() => {})));
    await rt.close();
  }
});
