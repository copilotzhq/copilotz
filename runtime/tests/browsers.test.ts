/**
 * A browser's connection, across a reconnect: back on a new transport
 * connection before the old one is noticed gone, it keeps its new stream
 * (and its reads); only the connection that went closes what it opened.
 */
import { assertEquals } from "@std/assert";
import { BROWSER, createBrowsers, READ } from "../browsers.ts";
import { decode, encode } from "../wire.ts";
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
