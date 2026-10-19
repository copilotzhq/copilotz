import { testEffect } from "../../runtime/testing/effects.ts";
import { createHash } from "node:crypto";
import { definePlugin as defineFixturePlugin } from "@copilotz/copilotz/plugins";
import { assert, assertEquals, assertRejects } from "@std/assert";
import type {
  ActionContext,
  ActionDefinition,
} from "@copilotz/copilotz/actions";
import type {
  ContentInput,
  ContentRef,
  PendingContentRef,
  PreparedContent,
} from "@copilotz/copilotz/content";
import type { ToolResource } from "../core/authoring/define-tool/index.ts";

import {
  type PersistentTerminalService,
  persistentTerminalToolsPlugin,
} from "./index.ts";

type ContentTracker = {
  prepares: number;
  captures: number;
  capturedCounts: number[];
};

function pendingExport(
  index: number,
  mediaType: string,
  text: string,
): PendingContentRef {
  const bytes = new TextEncoder().encode(text);
  return {
    type: "content.pending",
    pendingRef: `pending:terminal-export:${index}`,
    mediaType,
    byteLength: bytes.byteLength,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function fixtureContext(
  tracker: ContentTracker = {
    prepares: 0,
    captures: 0,
    capturedCounts: [],
  },
  terminal?: PersistentTerminalService,
): ActionContext {
  let prepareIndex = 0;
  return {
    adapters: { terminal: { default: terminal } },
    effect: testEffect,
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
            bodyId: "logical:asset-a",
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
        return Promise.resolve({
          content: [ref],
          assets: [{
            id: ref.assetId,
            namespace: "space",
            mediaType: candidate.mediaType,
            body: candidate.bytes,
            byteLength: candidate.bytes.byteLength,
            digest: `sha256:${
              createHash("sha256").update(candidate.bytes).digest("hex")
            }`,
          }],
        });
      },
      capture(input: PreparedContent, options: { operationKey: string }) {
        tracker.captures += 1;
        tracker.capturedCounts.push(input.content.length);
        assertEquals(
          options.operationKey,
          "terminal:action-run-a:result-capture",
        );
        return Promise.resolve(
          input.assets.map((asset, index) =>
            pendingExport(
              index,
              asset.mediaType,
              new TextDecoder().decode(asset.body),
            )
          ),
        );
      },
      materialize() {
        throw new Error("Generated output must remain pending.");
      },
    },
  } as unknown as ActionContext;
}

Deno.test("persistent terminal tool delegates through an explicitly owned service", async () => {
  let shutdowns = 0;
  const tracker: ContentTracker = {
    prepares: 0,
    captures: 0,
    capturedCounts: [],
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
  const plugin = defineFixturePlugin({
    ...persistentTerminalToolsPlugin,
    adapters: { terminal: { default: service } },
  });
  const tools = plugin.resources.tools;
  const tool = tools?.persistent_terminal as ToolResource;
  const action = plugin.actions.persistent_terminal as ActionDefinition;

  assertEquals(Object.keys(tools ?? {}), ["persistent_terminal"]);

  assertEquals(tool.action, "persistent_terminal");
  assert(!("execute" in tool));
  assertEquals(
    await action.execute({ action: "run" }, fixtureContext(tracker, service)),
    {
      read: "asset://tenant-a/asset-a",
      published: pendingExport(0, "text/plain", "hello"),
    },
  );
  assertEquals(tracker, {
    prepares: 1,
    captures: 1,
    capturedCounts: [1],
  });
  assertEquals(shutdowns, 0);
  await service.shutdown();
  assertEquals(shutdowns, 1);
});

Deno.test("persistent terminal captures staged publishes and replaces spread refs with pending descriptors", async () => {
  const tracker: ContentTracker = {
    prepares: 0,
    captures: 0,
    capturedCounts: [],
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
    await persistentTerminalToolsPlugin.actions.persistent_terminal.execute(
      { action: "export_file" },
      fixtureContext(tracker, service),
    ),
    {
      first: {
        assetId: pendingExport(0, "text/plain", "one"),
        assetRef: pendingExport(0, "text/plain", "one"),
        mediaType: "text/plain",
        byteLength: 3,
      },
      nested: [{
        assetId: pendingExport(1, "application/octet-stream", "two"),
        assetRef: pendingExport(1, "application/octet-stream", "two"),
        mediaType: "application/octet-stream",
        byteLength: 3,
      }],
    },
  );
  assertEquals(tracker, {
    prepares: 2,
    captures: 1,
    capturedCounts: [2],
  });

  const invalidTracker: ContentTracker = {
    prepares: 0,
    captures: 0,
    capturedCounts: [],
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
      await persistentTerminalToolsPlugin.actions.persistent_terminal.execute(
        { action: "export_file" },
        fixtureContext(invalidTracker, invalid),
      ),
    TypeError,
  );
  assertEquals(invalidTracker, {
    prepares: 1,
    captures: 0,
    capturedCounts: [],
  });
});

Deno.test("persistent terminal canonical asset bridge enforces tenant scope", async () => {
  const service: PersistentTerminalService = Object.freeze({
    execute: (_input, context) => context.readAsset("asset://tenant-b/asset-a"),
    shutdown: () => Promise.resolve(),
  });
  await assertRejects(
    async () =>
      await persistentTerminalToolsPlugin.actions.persistent_terminal.execute({
        action: "run",
      }, fixtureContext(undefined, service)),
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
  const action = persistentTerminalToolsPlugin.actions.persistent_terminal;
  assertEquals(
    await action.execute(
      { action: "info" },
      fixtureContext(undefined, service),
    ),
    {
      ok: true,
      asset: {
        assetId: "asset-a",
        kind: "text",
        role: "tool.output",
        mediaType: "text/plain",
      },
    },
  );
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
      async () =>
        await action.execute(
          { action: "info" },
          fixtureContext(undefined, service),
        ),
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
