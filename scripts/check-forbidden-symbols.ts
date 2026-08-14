const repositoryRoot = new URL("../", import.meta.url);

const forbidden = [
  "queueId",
  "unsafeGraph",
  "ResourceManifest",
  "producedEvents",
  "runGeneration",
  "workerLease",
  "NEW_MESSAGE",
  "LLM_CALL",
  "LLM_RESULT",
  "TOOL_CALL",
  "TOOL_RESULT",
  "ASSET_CREATED",
  "startNodeInteractiveCli",
  "createNodeInteractiveCliIo",
  "StartNodeInteractiveCliOptions",
  "allowedAgents",
  "allowedSkills",
  "createDenoWorkspaceToolsPlugin",
  "createDenoProcessToolsPlugin",
  "CreateDenoWorkspaceToolsPluginOptions",
  "CreateDenoProcessToolsPluginOptions",
  "DENO_WORKSPACE_TOOL_IDS",
  "DENO_PROCESS_TOOL_IDS",
  "DenoWorkspaceToolId",
  "DenoProcessToolId",
  "createDenoPersistentTerminalService",
  "CreateDenoPersistentTerminalServiceOptions",
  "buildDenoTerminalWorkspaceRoot",
  "connectStdioMcp",
  "createStdioServerWorkflowToolCatalog",
  "CreateStdioServerWorkflowToolCatalogOptions",
  "EventNativeRunHandle",
  "EventNativeRunInput",
  "brain_node",
  "continuityPatch",
  "MemoryConsolidator",
  "WorkflowPromptMemory",
] as const;

const retiredOxian = [
  [/\bpersistAcceptance\b/, "persistAcceptance"],
  [/\.whenReady\s*\(/, "whenReady"],
  [/\bcreateWorkerHost\b/, "createWorkerHost"],
  [/\bWorkerHost\b/, "WorkerHost"],
  [/\bcreateWorkerClient\b/, "createWorkerClient"],
  [/\bWorkerClient\b/, "WorkerClient"],
  [/\bWebSocketWorkerOptions\b/, "WebSocketWorkerOptions"],
  [/\bcredentialPersistence\b/, "credentialPersistence"],
  [/@oxian\/oxian-js@0\.20\.0-rc\.7/, "Oxian 0.20.0-rc.7"],
  [/@oxian\/ominipg@0\.9\.0-rc\.3/, "Ominipg 0.9.0-rc.3"],
  [
    /transport\s*:\s*\{\s*type\s*:\s*["']in-process["']\s*,\s*hypervisor/,
    "direct Hypervisor transport",
  ],
  [
    /transport\s*:\s*\{\s*type\s*:\s*["']websocket["']\s*,\s*url/,
    "flat WebSocket transport",
  ],
] as const;

const ignoredDirectories = new Set([
  ".git",
  ".deno",
  "dist",
  "node_modules",
]);

function allowed(path: string): boolean {
  return path.startsWith("migration/v1/") ||
    path.startsWith("migration/memory-v4/") ||
    path.startsWith("contracts/") ||
    path.endsWith(".test.ts") ||
    path === "server/v1-sse.ts" ||
    path === "docs/migration-v3.md" ||
    path === "docs/v3/downstream-migration.md" ||
    path === "docs/v3/feature-test-parity.md" ||
    path === "docs/application-resilience-plan.md" ||
    path === "docs/memory.md" ||
    path === "scripts/check-forbidden-symbols.ts";
}

function scannable(path: string): boolean {
  return /\.(?:ts|tsx|js|jsx|md|json|jsonc)$/.test(path);
}

async function* files(
  directory: URL,
  prefix = "",
): AsyncGenerator<Readonly<{ path: string; url: URL }>> {
  for await (const entry of Deno.readDir(directory)) {
    if (ignoredDirectories.has(entry.name)) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), directory);
    if (entry.isDirectory) yield* files(url, path);
    else if (entry.isFile && scannable(path)) yield { path, url };
  }
}

const violations: string[] = [];
for await (const file of files(repositoryRoot)) {
  const lines = (await Deno.readTextFile(file.url)).split(/\r?\n/);
  if (file.path !== "scripts/check-forbidden-symbols.ts") {
    for (let index = 0; index < lines.length; index += 1) {
      for (const [pattern, label] of retiredOxian) {
        if (pattern.test(lines[index])) {
          violations.push(`${file.path}:${index + 1}: ${label}`);
        }
      }
    }
  }
  if (allowed(file.path)) continue;
  for (let index = 0; index < lines.length; index += 1) {
    for (const symbol of forbidden) {
      const pattern = new RegExp(`\\b${symbol}\\b`);
      if (pattern.test(lines[index])) {
        violations.push(`${file.path}:${index + 1}: ${symbol}`);
      }
    }
  }
}

if (violations.length) {
  console.error(
    "Removed architecture symbols reappeared:\n" + violations.join("\n"),
  );
  Deno.exit(1);
}

console.log(
  `Forbidden-symbol audit passed (${forbidden.length} architecture symbols and ${retiredOxian.length} retired Oxian patterns).`,
);
