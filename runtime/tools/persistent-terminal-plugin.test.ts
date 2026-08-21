import { assert, assertEquals, assertRejects } from "@std/assert";

import type { WorkflowTool, WorkflowToolExecutionContext } from "./types.ts";
import {
  createPersistentTerminalToolsPlugin,
  type PersistentTerminalService,
} from "./persistent-terminal-plugin.ts";

function toolFrom(service: PersistentTerminalService): WorkflowTool {
  const plugin = createPersistentTerminalToolsPlugin({ terminal: service });
  return plugin.resources.tools?.[0] as WorkflowTool;
}

function fixtureContext(): WorkflowToolExecutionContext {
  return {
    namespace: "tenant-a",
    correlationId: "correlation-a",
    idempotencyKey: "delivery-a",
    threadId: "thread-a",
    senderId: "agent-a",
    threadMetadata: { project: "project-a" },
    execution: { agentId: "agent-a" },
    processor: {
      signal: new AbortController().signal,
      content: {
        async get(id: string) {
          return id === "asset-a"
            ? {
              id,
              namespace: "tenant-a",
              mediaType: "text/plain",
              byteLength: 5,
              digest: "sha256:fixture",
              state: "ready",
              location: { kind: "database", encoding: "utf8" },
              createdAt: "2026-08-06T00:00:00.000Z",
            }
            : null;
        },
        resolve: () =>
          Promise.resolve({ bytes: new TextEncoder().encode("hello") }),
        publish: () =>
          Promise.resolve({
            id: "asset-b",
            namespace: "tenant-a",
            mediaType: "text/plain",
            byteLength: 5,
            digest: "sha256:published",
            state: "ready",
            location: { kind: "database", encoding: "utf8" },
            createdAt: "2026-08-06T00:00:00.000Z",
          }),
      },
    },
  } as unknown as WorkflowToolExecutionContext;
}

Deno.test("persistent terminal tool delegates through an explicitly owned service", async () => {
  let shutdowns = 0;
  const service: PersistentTerminalService = Object.freeze({
    async execute(input, context) {
      assertEquals(input.action, "run");
      assertEquals(context.namespace, "tenant-a");
      assertEquals(context.project, "project-a");
      assertEquals(context.agentId, "agent-a");
      const read = await context.readAsset("asset://tenant-a/asset-a");
      const published = await context.publishAsset({
        bytes: read.bytes,
        mediaType: read.mediaType,
        operationKey: "fixture-export",
      });
      return { read: read.assetRef, published: published.assetRef };
    },
    shutdown() {
      shutdowns += 1;
      return Promise.resolve();
    },
  });
  const plugin = createPersistentTerminalToolsPlugin({ terminal: service });
  const tool = plugin.resources.tools?.[0] as WorkflowTool;

  assertEquals(plugin.manifest.provides.tools, ["persistent_terminal"]);
  assert(Object.isFrozen(tool));
  assertEquals(await tool.execute({ action: "run" }, fixtureContext()), {
    read: "asset://tenant-a/asset-a",
    published: "asset://tenant-a/asset-b",
  });
  assertEquals(shutdowns, 0);
  await service.shutdown();
  assertEquals(shutdowns, 1);
});

Deno.test("persistent terminal canonical asset bridge enforces tenant scope", async () => {
  const service: PersistentTerminalService = Object.freeze({
    execute: (_input, context) => context.readAsset("asset://tenant-b/asset-a"),
    shutdown: () => Promise.resolve(),
  });
  await assertRejects(
    async () =>
      await toolFrom(service).execute({ action: "run" }, fixtureContext()),
    Error,
    "active namespace",
  );
});

Deno.test("persistent terminal tool boundary is factory-first and runtime-neutral", async () => {
  const source = await Deno.readTextFile(
    new URL("persistent-terminal-plugin.ts", import.meta.url),
  );
  assert(!/^\s*(?:export\s+)?class\s/m.test(source));
  assert(!/\bDeno\.|\bBun\.|from\s+["']node:/.test(source));
  assert(!/resources\/tools\/persistent_terminal/.test(source));
});
