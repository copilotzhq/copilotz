import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";

import type { PersistentTerminalServiceContext } from "../../actions/index.ts";
import {
  buildPersistentTerminalSessionKey,
  buildTerminalWorkspaceRoot,
  createPersistentTerminalService,
  normalizeTerminalFilePath,
  resolveTerminalFilePath,
} from "./index.ts";

function context(
  overrides: Partial<PersistentTerminalServiceContext> = {},
): PersistentTerminalServiceContext {
  return {
    namespace: "tenant-a",
    project: "project-a",
    agentId: "agent-a",
    threadId: "thread-a",
    signal: new AbortController().signal,
    readAsset: () =>
      Promise.resolve({
        assetRef: "asset://tenant-a/asset-a",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode("asset body"),
      }),
    publishAsset: (input) =>
      Promise.resolve({
        assetId: "asset-exported",
        assetRef: "asset://tenant-a/asset-exported",
        mediaType: input.mediaType,
        byteLength: input.bytes.byteLength,
      }),
    ...overrides,
  };
}

Deno.test("Deno terminal session keys and roots preserve sharing boundaries", () => {
  assertEquals(
    buildPersistentTerminalSessionKey(
      "tenant-a",
      "project-a",
      "agent-a",
      "agent",
    ),
    "tenant-a:project-a:agent-a:agent",
  );
  assertEquals(
    buildPersistentTerminalSessionKey(
      "tenant-a",
      "project-a",
      "agent-b",
      "project",
    ),
    buildPersistentTerminalSessionKey(
      "tenant-a",
      "project-a",
      "agent-a",
      "project",
    ),
  );
  assertEquals(
    buildPersistentTerminalSessionKey(
      "tenant-a",
      "project-b",
      "agent-b",
      "tenant",
    ),
    buildPersistentTerminalSessionKey(
      "tenant-a",
      "project-a",
      "agent-a",
      "tenant",
    ),
  );
  assertStringIncludes(
    buildTerminalWorkspaceRoot({
      namespace: "tenant-a",
      project: "project-a",
      agentId: "agent-a",
      scope: "agent",
      workspaceBase: "/tmp/copilotz-terminals",
      projectRoot: "/tmp/project",
    }),
    "/tenant-a/project-a/agent-a",
  );
});

Deno.test("Deno terminal paths remain inside the selected workspace", () => {
  assertEquals(
    normalizeTerminalFilePath("artifacts/result.txt"),
    "artifacts/result.txt",
  );
  assertStringIncludes(
    resolveTerminalFilePath("/tmp/project", "artifacts/result.txt"),
    "/tmp/project/artifacts/result.txt",
  );
  for (const value of ["../secret", "/tmp/secret", "~/secret", "."]) {
    assertThrows(
      () => resolveTerminalFilePath("/tmp/project", value),
      TypeError,
    );
  }
});

Deno.test("Deno persistent terminal keeps shell state and closes owned sessions", async () => {
  const root = await Deno.makeTempDir({ prefix: "copilotz-terminal-" });
  const terminal = createPersistentTerminalService({
    projectRoot: root,
    workspaceBase: null,
    createId: () => "fixture",
  });
  try {
    assertEquals(
      await terminal.execute({
        action: "run",
        command: "export COPILOTZ_TERMINAL_STATE=kept",
      }, context()),
      { output: "", exitCode: 0 },
    );
    assertEquals(
      await terminal.execute({
        action: "run",
        command: 'printf %s "$COPILOTZ_TERMINAL_STATE"',
      }, context()),
      { output: "kept", exitCode: 0 },
    );
    const listed = await terminal.execute({ action: "list" }, context()) as {
      count: number;
    };
    assertEquals(listed.count, 1);
    const info = await terminal.execute({ action: "info" }, context()) as {
      exists: boolean;
    };
    assert(info.exists);
  } finally {
    await terminal.shutdown();
  }
  await assertRejects(
    () => terminal.execute({ action: "info" }, context()),
    Error,
    "shut down",
  );
});

Deno.test("Deno terminal transfers canonical assets without owning storage", async () => {
  const root = await Deno.makeTempDir({ prefix: "copilotz-terminal-assets-" });
  let published: Uint8Array | undefined;
  const terminal = createPersistentTerminalService({
    workspaceBase: root,
    createId: () => "asset-fixture",
  });
  const toolContext = context({
    publishAsset(input) {
      published = input.bytes;
      return Promise.resolve({
        assetId: "asset-exported",
        assetRef: "asset://tenant-a/asset-exported",
        mediaType: input.mediaType,
        byteLength: input.bytes.byteLength,
      });
    },
  });
  try {
    const uploaded = await terminal.execute({
      action: "upload_asset",
      assetRef: "asset://tenant-a/asset-a",
      path: "inputs/source.txt",
    }, toolContext) as { size: number; workspaceRoot: string };
    assertEquals(uploaded.size, 10);
    assertEquals(
      await Deno.readTextFile(
        resolveTerminalFilePath(uploaded.workspaceRoot, "inputs/source.txt"),
      ),
      "asset body",
    );
    await terminal.execute({
      action: "run",
      command: "printf changed > outputs.txt",
    }, toolContext);
    const exported = await terminal.execute({
      action: "export_file",
      path: "outputs.txt",
      mimeType: "text/plain",
    }, toolContext) as { assetRef: string; size: number };
    assertEquals(exported.assetRef, "asset://tenant-a/asset-exported");
    assertEquals(exported.size, 7);
    assertEquals(new TextDecoder().decode(published), "changed");
  } finally {
    await terminal.shutdown();
  }
});

Deno.test("Deno persistent terminal is closure-backed and factory-first", async () => {
  const source = await Deno.readTextFile(
    new URL("index.ts", import.meta.url),
  );
  assert(!/^\s*(?:export\s+)?class\s/m.test(source));
  assert(!/^const sessions\s*=/m.test(source));
  assert(!/resources\/tools\/persistent_terminal/.test(source));
});
