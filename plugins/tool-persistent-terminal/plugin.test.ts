import { assert, assertEquals, assertRejects } from "@std/assert";
import type {
  ActionContext,
  ActionDefinition,
} from "@copilotz/copilotz/actions";
import type { ContentInput, ContentRef } from "@copilotz/copilotz/content";
import type { ToolResource } from "../tools/authoring/define-tool/index.ts";

import {
  createPersistentTerminalToolsPlugin,
  type PersistentTerminalService,
} from "./index.ts";

function actionFrom(service: PersistentTerminalService): ActionDefinition {
  const plugin = createPersistentTerminalToolsPlugin({ terminal: service });
  return plugin.actions.persistent_terminal as ActionDefinition;
}

type ContentTracker = {
  prepares: number;
  materializes: number;
  materializedCounts: number[];
};

function fixtureContext(
  tracker: ContentTracker = {
    prepares: 0,
    materializes: 0,
    materializedCounts: [],
  },
): ActionContext {
  let prepareIndex = 0;
  return {
    namespace: "tenant-a",
    signal: new AbortController().signal,
    action: {
      id: "copilotz.tools.persistent-terminal.persistent_terminal",
      runId: "action-run-a",
      metadata: {
        schema: "copilotz.core.tool-action.v1",
        threadId: "thread-a",
        agentId: "agent-a",
        project: "project-a",
      },
    },
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
      prepare(input: ContentInput | readonly ContentInput[]) {
        tracker.prepares += 1;
        const values = Array.isArray(input) ? input : [input];
        if (values.length !== 1 || typeof values[0] !== "object") {
          throw new TypeError("Expected one binary input.");
        }
        const candidate = values[0] as Extract<
          ContentInput,
          { bytes: Uint8Array }
        >;
        const index = prepareIndex++;
        const ref: ContentRef = {
          assetId: `asset-candidate-${index}`,
          kind: candidate.type,
          role: candidate.role ?? "attachment",
          mediaType: candidate.mediaType,
          ...(candidate.name ? { name: candidate.name } : {}),
          ...(candidate.disposition
            ? { disposition: candidate.disposition }
            : {}),
        };
        return Promise.resolve({ content: [ref], assets: [] });
      },
      materialize(input: { content: readonly ContentRef[] }) {
        tracker.materializes += 1;
        tracker.materializedCounts.push(input.content.length);
        return Promise.resolve(input.content.map((ref, index) => ({
          ...ref,
          assetId: `asset-${String.fromCharCode("b".charCodeAt(0) + index)}`,
        })));
      },
    },
  } as unknown as ActionContext;
}

Deno.test("persistent terminal tool delegates through an explicitly owned service", async () => {
  let shutdowns = 0;
  const tracker: ContentTracker = {
    prepares: 0,
    materializes: 0,
    materializedCounts: [],
  };
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
  const tools = plugin.resources.tools;
  const tool = tools?.persistent_terminal as ToolResource;
  const action = plugin.actions.persistent_terminal as ActionDefinition;

  assertEquals(Object.keys(tools ?? {}), ["persistent_terminal"]);
  assert(Object.isFrozen(tool));
  assertEquals(tool.action, "persistent_terminal");
  assert(!("execute" in tool));
  assertEquals(
    await action.execute({ action: "run" }, fixtureContext(tracker)),
    {
      read: "asset://tenant-a/asset-a",
      published: "asset://tenant-a/asset-b",
    },
  );
  assertEquals(tracker, {
    prepares: 1,
    materializes: 1,
    materializedCounts: [1],
  });
  assertEquals(shutdowns, 0);
  await service.shutdown();
  assertEquals(shutdowns, 1);
});

Deno.test("persistent terminal stages all publishes and remaps spread refs atomically", async () => {
  const tracker: ContentTracker = {
    prepares: 0,
    materializes: 0,
    materializedCounts: [],
  };
  const service: PersistentTerminalService = Object.freeze({
    async execute(_input, context) {
      const first = await context.publishAsset({
        bytes: new TextEncoder().encode("one"),
        mediaType: "text/plain",
        operationKey: "first",
      });
      const second = await context.publishAsset({
        bytes: new TextEncoder().encode("two"),
        mediaType: "application/octet-stream",
        operationKey: "second",
      });
      return { first: { ...first }, nested: [{ ...second }] };
    },
    shutdown: () => Promise.resolve(),
  });
  assertEquals(
    await actionFrom(service).execute(
      { action: "export_file" },
      fixtureContext(tracker),
    ),
    {
      first: {
        assetId: "asset-b",
        assetRef: "asset://tenant-a/asset-b",
        mediaType: "text/plain",
        byteLength: 3,
      },
      nested: [{
        assetId: "asset-c",
        assetRef: "asset://tenant-a/asset-c",
        mediaType: "application/octet-stream",
        byteLength: 3,
      }],
    },
  );
  assertEquals(tracker, {
    prepares: 2,
    materializes: 1,
    materializedCounts: [2],
  });

  const invalidTracker: ContentTracker = {
    prepares: 0,
    materializes: 0,
    materializedCounts: [],
  };
  const invalid: PersistentTerminalService = Object.freeze({
    async execute(_input, context) {
      await context.publishAsset({
        bytes: new TextEncoder().encode("staged"),
        mediaType: "text/plain",
        operationKey: "invalid",
      });
      return new Uint8Array([1, 2, 3]);
    },
    shutdown: () => Promise.resolve(),
  });
  await assertRejects(
    async () =>
      await actionFrom(invalid).execute(
        { action: "export_file" },
        fixtureContext(invalidTracker),
      ),
    TypeError,
  );
  assertEquals(invalidTracker, {
    prepares: 1,
    materializes: 0,
    materializedCounts: [],
  });
});

Deno.test("persistent terminal canonical asset bridge enforces tenant scope", async () => {
  const service: PersistentTerminalService = Object.freeze({
    execute: (_input, context) => context.readAsset("asset://tenant-b/asset-a"),
    shutdown: () => Promise.resolve(),
  });
  await assertRejects(
    async () =>
      await actionFrom(service).execute({ action: "run" }, fixtureContext()),
    Error,
    "active namespace",
  );
});

Deno.test("persistent terminal rejects non-JSON custom service results", async () => {
  let result: unknown = {
    ok: true,
    asset: {
      assetId: "asset-a",
      kind: "text",
      role: "tool.output",
      mediaType: "text/plain",
    },
  };
  const service: PersistentTerminalService = Object.freeze({
    execute: () => Promise.resolve(result),
    shutdown: () => Promise.resolve(),
  });
  const action = actionFrom(service);
  assertEquals(await action.execute({ action: "info" }, fixtureContext()), {
    ok: true,
    asset: {
      assetId: "asset-a",
      kind: "text",
      role: "tool.output",
      mediaType: "text/plain",
    },
  });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const inherited = Object.assign(Object.create({ inherited: true }), {
    own: true,
  });
  const extendedArray = ["kept"];
  Object.defineProperty(extendedArray, "4294967295", {
    value: "dropped",
    enumerable: true,
  });
  for (
    const candidate of [
      new Uint8Array([1, 2, 3]),
      new Blob(["body"]),
      new ReadableStream<Uint8Array>(),
      new Date("2026-08-23T00:00:00.000Z"),
      inherited,
      cycle,
      extendedArray,
    ]
  ) {
    result = candidate;
    await assertRejects(
      async () => await action.execute({ action: "info" }, fixtureContext()),
      TypeError,
    );
  }
});

Deno.test("persistent terminal tool boundary is factory-first and runtime-neutral", async () => {
  const source = await Deno.readTextFile(
    new URL("plugin.ts", import.meta.url),
  );
  assert(!/^\s*(?:export\s+)?class\s/m.test(source));
  assert(!/\bDeno\.|\bBun\.|from\s+["']node:/.test(source));
  assert(!/resources\/tools\/persistent_terminal/.test(source));
});
