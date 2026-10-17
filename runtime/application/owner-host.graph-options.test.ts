import assert from "node:assert/strict";
import { test } from "node:test";
import { defineCollection } from "../collections/definition.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createOwnerHost, type OwnerHostOptions } from "./owner-host.ts";

test("fresh host has no resume graph budget while resume captures the complete namespace inventory before SQL", async () => {
  const registry = createPluginRegistry({
    collections: {
      large: defineCollection({
        name: "large_note",
        schema: {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 600 }, (_, index) => [
              `field${index}`,
              { type: "string" as const },
            ]),
          ),
        } as const,
      }),
    },
  });
  const firstSql = new Error("Reached first SQL without opening a database.");
  let queries = 0, transactions = 0, transports = 0;
  const options: OwnerHostOptions = {
    ownerId: "owner",
    holderId: "holder",
    schema: "public",
    initialization: "fresh",
    registry,
    session: {
      query() {
        queries++;
        throw firstSql;
      },
      transaction() {
        transactions++;
        throw firstSql;
      },
    },
    policy: {
      ingress: () => undefined,
      worker: () => ({ ctx: true, settlement: true }),
      input() {},
      collections: () => ({}),
      effectOutcome: () => false,
      effectNotStarted: () => false,
    },
    transport: { transports: [] },
    createTransport() {
      transports++;
      throw new Error("Unexpected transport.");
    },
  };
  await assert.rejects(
    createOwnerHost(options, ["space"]),
    (error) => error === firstSql,
  );
  assert.equal(queries + transactions, 1);
  queries = 0;
  transactions = 0;
  await assert.rejects(
    createOwnerHost({
      ...options,
      initialization: { mode: "resume", expectedEpoch: 1 },
    }, ["space"]),
    /Startup configuration exceeds its inventory budget/,
  );
  assert.equal(queries + transactions, 0);
  assert.equal(transports, 0);
});
