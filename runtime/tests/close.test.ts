/**
 * A runtime closes promptly with browsers still connected: they're let go,
 * not waited on (a host closing an idle org, or moving one).
 */
import { assert } from "@std/assert";
import { type Actor, createRuntime } from "../mod.ts";
import { connect } from "../client.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { host, test } from "../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };

test("a runtime closes promptly with a browser still connected", async () => {
  const topic = `close-test.${crypto.randomUUID()}`;
  const tickets = new Map<string, Actor>();
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [],
    transports: [{ type: "in-process", config: { topic } }],
    admit: (secret) => tickets.get(secret),
  });
  const client = connect({
    transport: { type: "in-process", config: { topic } },
    ticket: () => {
      const secret = crypto.randomUUID();
      tickets.set(secret, ana);
      return Promise.resolve(secret);
    },
    plugins: [],
  });
  try {
    for (let i = 0; i < 200 && rt.stats().browsers === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(rt.stats().browsers === 1, "the browser connected");
    const started = performance.now();
    await rt.close();
    const took = performance.now() - started;
    assert(took < 3_000, `closed in ${Math.round(took)} ms`);
  } finally {
    await client.close();
  }
});

test("a runtime closes promptly with a browser connected over a socket", async () => {
  const tickets = new Map<string, Actor>();
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [],
    transports: [{ type: "websocket", config: { path: "/browsers" } }],
    admit: (secret) => tickets.get(secret),
  });
  const listener = await host(rt.hypervisor);
  const client = connect({
    transport: {
      type: "websocket",
      config: {
        url: `ws://127.0.0.1:${new URL(String(listener.url)).port}/browsers`,
        allowInsecureLoopback: true,
      },
    },
    ticket: () => {
      const secret = crypto.randomUUID();
      tickets.set(secret, ana);
      return Promise.resolve(secret);
    },
    plugins: [],
  });
  try {
    for (let i = 0; i < 300 && rt.stats().browsers === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(rt.stats().browsers === 1, "the browser connected");
    const started = performance.now();
    await rt.close();
    const took = performance.now() - started;
    assert(took < 3_000, `closed in ${Math.round(took)} ms`);
  } finally {
    await client.close();
    await listener.shutdown();
  }
});
