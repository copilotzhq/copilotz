import type { NewTool } from "@/types/index.ts";
import { getPublicThreadMetadata } from "@/runtime/thread-metadata.ts";
import { buildAssetRefForStore, resolveAssetIdForStore } from "@/runtime/storage/assets.ts";
import type { ToolExecutionContext } from "@/resources/processors/tool_call/index.ts";
import { dirname, isAbsolute, relative, resolve } from "@std/path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PersistentTerminalParams {
  action: "run" | "info" | "restart" | "close" | "list" | "upload_asset" | "export_file";
  command?: string;
  cwd?: string;
  timeout?: number;
  scope?: "agent" | "project" | "tenant";
  project?: string;
  path?: string;
  assetRef?: string;
  ref?: string;
  mimeType?: string;
  overwrite?: boolean;
}

interface ToolContext extends Pick<ToolExecutionContext, "assetStore"> {
  senderId?: string;
  threadId?: string;
  namespace?: string;
  onCancel?: (cb: () => void) => () => void;
  cancelled?: boolean;
  cancelReason?: string;
  db?: {
    ops: {
      getThreadById: (id: string) => Promise<
        {
          metadata?: Record<string, unknown> | null;
          externalId?: string | null;
        } | undefined
      >;
    };
  };
}

interface SessionRecord {
  process: Deno.ChildProcess;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  outputBuffer: string;
  stdoutPump: Promise<void>;
  stderrPump: Promise<void>;
  closed: boolean;
  workspaceRoot: string;
  scope: "agent" | "project" | "tenant";
  namespace: string;
  project: string;
  agentId: string;
  startedAt: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const sessions = new Map<string, SessionRecord>();
const textEncoder = new TextEncoder();
const MAX_OUTPUT_BUFFER_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 128) || "unknown";
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

function getMaxArtifactBytes(): number {
  // deno-lint-ignore no-explicit-any
  const denoNs = (globalThis as any).Deno;
  const raw = denoNs?.env?.get?.("COPILOTZ_MAX_ARTIFACT_BYTES");
  const parsed = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_ARTIFACT_BYTES;
}

export function resolveBaseDir(): string {
  // deno-lint-ignore no-explicit-any
  const denoNs = (globalThis as any).Deno;
  const env = denoNs?.env?.get?.("COPILOTZ_WORKSPACES_DIR");
  if (typeof env === "string" && env.length > 0) return env.replace(/\/+$/, "");
  return denoNs?.cwd?.() ?? ".";
}

function useIsolatedWorkspaceRoots(): boolean {
  // deno-lint-ignore no-explicit-any
  const denoNs = (globalThis as any).Deno;
  const env = denoNs?.env?.get?.("COPILOTZ_WORKSPACES_DIR");
  return typeof env === "string" && env.length > 0;
}

function resolveScopedAgentId(
  agentId: string,
  scope: "agent" | "project" | "tenant",
): string {
  switch (scope) {
    case "tenant":
      return "__tenant__";
    case "project":
      return "__project__";
    case "agent":
    default:
      return agentId;
  }
}

function resolveScopedProject(
  project: string,
  scope: "agent" | "project" | "tenant",
): string {
  return scope === "tenant" ? "__tenant__" : project;
}

export function buildWorkspaceRoot(
  namespace: string,
  project: string,
  agentId: string,
  scope: "agent" | "project" | "tenant",
): string {
  const base = resolveBaseDir();
  if (!useIsolatedWorkspaceRoots()) return base;
  const ns = sanitize(namespace);
  const proj = sanitize(project);
  const agent = sanitize(agentId);
  switch (scope) {
    case "tenant":
      return `${base}/${ns}`;
    case "project":
      return `${base}/${ns}/${proj}`;
    case "agent":
    default:
      return `${base}/${ns}/${proj}/${agent}`;
  }
}

export function buildSessionKey(
  namespace: string,
  project: string,
  agentId: string,
  scope: "agent" | "project" | "tenant",
): string {
  const scopedAgentId = resolveScopedAgentId(agentId, scope);
  const scopedProject = resolveScopedProject(project, scope);
  return `${sanitize(namespace)}:${sanitize(scopedProject)}:${
    sanitize(scopedAgentId)
  }:${scope}`;
}

export function normalizeWorkspaceFilePath(requestedPath: string): string {
  const normalized = requestedPath.replace(/\\/g, "/");
  if (
    !normalized ||
    normalized === "." ||
    normalized.endsWith("/") ||
    normalized.includes("\0") ||
    normalized.includes("~") ||
    isAbsolute(normalized)
  ) {
    throw new Error("Workspace file path must be a relative file path.");
  }
  return normalized;
}

export function resolveWorkspaceFilePath(
  workspaceRoot: string,
  requestedPath: string,
): string {
  const root = resolve(workspaceRoot);
  const target = resolve(root, normalizeWorkspaceFilePath(requestedPath));
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Workspace file path escapes the terminal root.");
  }
  return target;
}

async function resolveProject(
  explicit?: string,
  context?: ToolContext,
): Promise<string> {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  if (!context?.threadId || !context.db?.ops) return "default";
  try {
    const thread = await context.db.ops.getThreadById(context.threadId);
    if (!thread) return context.threadId;
    const meta = getPublicThreadMetadata(thread.metadata);
    if (typeof meta?.project === "string" && meta.project.length > 0) {
      return meta.project;
    }
    if (typeof thread.externalId === "string" && thread.externalId.length > 0) {
      return thread.externalId;
    }
    return context.threadId;
  } catch {
    return context.threadId;
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function startStreamPump(
  session: SessionRecord,
  stream: ReadableStream<Uint8Array>,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  return (async () => {
    try {
      while (!session.closed) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value?.length) {
          session.outputBuffer += decoder.decode(value, { stream: true });
          if (session.outputBuffer.length > MAX_OUTPUT_BUFFER_BYTES) {
            session.outputBuffer = session.outputBuffer.slice(
              session.outputBuffer.length - MAX_OUTPUT_BUFFER_BYTES,
            );
          }
        }
      }
      const tail = decoder.decode();
      if (tail && !session.closed) session.outputBuffer += tail;
    } catch {
      // Ignore background read errors during shutdown
    } finally {
      try {
        reader.releaseLock();
      } catch { /* */ }
    }
  })();
}

async function ensureDir(path: string): Promise<void> {
  // deno-lint-ignore no-explicit-any
  const denoNs = (globalThis as any).Deno;
  if (!denoNs?.mkdir) {
    throw new Error("persistent_terminal requires Deno runtime");
  }
  await denoNs.mkdir(path, { recursive: true });
}

async function createSession(
  key: string,
  workspaceRoot: string,
  scope: "agent" | "project" | "tenant",
  namespace: string,
  project: string,
  agentId: string,
): Promise<SessionRecord> {
  await ensureDir(workspaceRoot);

  // deno-lint-ignore no-explicit-any
  const denoNs = (globalThis as any).Deno;
  if (!denoNs?.Command) {
    throw new Error("persistent_terminal requires Deno runtime");
  }

  const cmd = new denoNs.Command("bash", {
    cwd: workspaceRoot,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const session: SessionRecord = {
    process: child,
    writer: child.stdin.getWriter(),
    outputBuffer: "",
    stdoutPump: Promise.resolve(),
    stderrPump: Promise.resolve(),
    closed: false,
    workspaceRoot,
    scope,
    namespace,
    project,
    agentId,
    startedAt: new Date().toISOString(),
  };
  session.stdoutPump = startStreamPump(session, child.stdout);
  session.stderrPump = startStreamPump(session, child.stderr);
  sessions.set(key, session);
  return session;
}

async function closeSession(key: string): Promise<void> {
  const session = sessions.get(key);
  if (!session) return;
  sessions.delete(key);
  session.closed = true;

  try {
    await session.writer.close();
  } catch {
    /* */
  } finally {
    try {
      session.writer.releaseLock();
    } catch { /* */ }
  }

  const statusPromise = session.process.status.catch(() => undefined);
  try {
    session.process.kill();
  } catch { /* */ }

  const exited = await Promise.race([
    statusPromise.then(() => true),
    sleep(500).then(() => false),
  ]);
  if (!exited) {
    try {
      session.process.kill("SIGKILL");
    } catch { /* */ }
  }

  await Promise.allSettled([
    statusPromise,
    session.stdoutPump,
    session.stderrPump,
  ]);
}

async function ensureSession(
  key: string,
  workspaceRoot: string,
  scope: "agent" | "project" | "tenant",
  namespace: string,
  project: string,
  agentId: string,
): Promise<SessionRecord> {
  const existing = sessions.get(key);
  if (existing && !existing.closed) return existing;
  if (existing) await closeSession(key);
  return createSession(key, workspaceRoot, scope, namespace, project, agentId);
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

async function readOutputUntil(
  session: SessionRecord,
  uuid: string,
  timeoutMs?: number,
): Promise<{ output: string; exitCode: number | null }> {
  const markerPrefix = `__COPILOTZ_END_${uuid}__:`;
  const deadline = typeof timeoutMs === "number" ? Date.now() + timeoutMs : null;

  while (deadline === null || Date.now() <= deadline) {
    const idx = session.outputBuffer.indexOf(markerPrefix);
    if (idx !== -1) {
      const lineEnd = session.outputBuffer.indexOf("\n", idx);
      if (lineEnd === -1) {
        await sleep(25);
        continue;
      }

      const output = session.outputBuffer.slice(0, idx).trimEnd();
      const markerLine = session.outputBuffer.slice(idx, lineEnd).trim();
      session.outputBuffer = session.outputBuffer.slice(lineEnd + 1);
      const exitCodeText = markerLine.slice(markerPrefix.length).trim();
      const exitCode = Number.parseInt(exitCodeText, 10);
      return { output, exitCode: Number.isNaN(exitCode) ? null : exitCode };
    }

    if (session.closed) throw new Error("Terminal session ended unexpectedly");
    await sleep(25);
  }

  if (typeof timeoutMs === "number") {
    throw new Error(`Command timed out after ${timeoutMs / 1000} seconds`);
  }
  throw new Error("Command timed out");
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const persistentTerminalTool: NewTool = {
  key: "persistent_terminal",
  name: "Persistent Terminal",
  description:
    "Scoped persistent bash terminal. Sessions are isolated by tenant (namespace), project (thread metadata or ID), and agent. " +
    "State (cwd, env vars) persists between calls within the same session. " +
    "Use scope='project' to share a terminal across agents working on the same project, or scope='tenant' for tenant-wide access.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["run", "info", "restart", "close", "list", "upload_asset", "export_file"],
        description:
          "'run': execute a command. 'info': show current session details. " +
          "'restart': kill and recreate the session. 'close': terminate the session. " +
          "'list': show all active sessions for the current scope. " +
          "'upload_asset': copy an asset into the workspace. " +
          "'export_file': save a workspace file back to the asset store.",
      },
      command: {
        type: "string",
        description: "Bash command to execute (required when action is 'run').",
      },
      cwd: {
        type: "string",
        description:
          "Directory to cd into before running the command (relative to the resolved terminal root). " +
          "By default the root is the current project/runtime cwd. " +
          "If COPILOTZ_WORKSPACES_DIR is set, the root becomes the isolated workspace tree under that base. " +
          "Must stay inside the resolved root.",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds.",
        default: 30,
        minimum: 1,
        maximum: 300,
      },
      scope: {
        type: "string",
        enum: ["agent", "project", "tenant"],
        default: "agent",
        description: "Workspace isolation level. " +
          "'agent': private terminal session for this agent. " +
          "'project': shared terminal session across agents in the same project/thread. " +
          "'tenant': shared terminal session across all projects for the namespace/tenant. " +
          "When COPILOTZ_WORKSPACES_DIR is unset, these scopes share the same project-root filesystem and differ by session state only.",
      },
      project: {
        type: "string",
        description: "Explicit project name for the workspace. " +
          "Overrides automatic resolution from thread metadata. " +
          "Use this to target a specific project workspace regardless of the current thread.",
      },
      path: {
        type: "string",
        description:
          "Relative file path inside the workspace for upload_asset/export_file. Must not escape the workspace.",
      },
      assetRef: {
        type: "string",
        description:
          "Asset ref to copy into the workspace when action is upload_asset.",
      },
      ref: {
        type: "string",
        description:
          "Alias for assetRef when action is upload_asset.",
      },
      mimeType: {
        type: "string",
        description:
          "MIME type to use when exporting a workspace file as an asset. Defaults to application/octet-stream.",
      },
      overwrite: {
        type: "boolean",
        description:
          "When false, upload_asset refuses to overwrite an existing workspace file. Defaults to false.",
      },
    },
    required: ["action"],
  },
  execute: async (
    {
      action,
      command,
      cwd,
      timeout,
      scope = "agent",
      project: explicitProject,
      path,
      assetRef,
      ref,
      mimeType,
      overwrite = false,
    }: PersistentTerminalParams,
    context?: ToolContext,
  ) => {
    const namespace = context?.namespace ?? "default";
    const agentId = context?.senderId ?? "anonymous";
    const project = await resolveProject(explicitProject, context);
    const scopedAgentId = resolveScopedAgentId(agentId, scope);

    const key = buildSessionKey(namespace, project, agentId, scope);
    const workspaceRoot = buildWorkspaceRoot(
      namespace,
      project,
      scopedAgentId,
      scope,
    );

    // --- list ---
    if (action === "list") {
      const prefix = `${sanitize(namespace)}:`;
      const active: Array<{
        sessionKey: string;
        scope: string;
        namespace: string;
        project: string;
        agentId: string;
        workspaceRoot: string;
        startedAt: string;
      }> = [];
      for (const [k, s] of sessions) {
        if (k.startsWith(prefix) && !s.closed) {
          active.push({
            sessionKey: k,
            scope: s.scope,
            namespace: s.namespace,
            project: s.project,
            agentId: s.agentId,
            workspaceRoot: s.workspaceRoot,
            startedAt: s.startedAt,
          });
        }
      }
      return { success: true, activeSessions: active, count: active.length };
    }

    // --- close ---
    if (action === "close") {
      await closeSession(key);
      return {
        success: true,
        message: "Terminal session closed.",
        sessionKey: key,
      };
    }

    // --- info ---
    if (action === "info") {
      const session = sessions.get(key);
      return {
        success: true,
        sessionKey: key,
        exists: !!session && !session.closed,
        scope,
        namespace,
        project,
        agentId: scopedAgentId,
        workspaceRoot,
        startedAt: session?.startedAt ?? null,
      };
    }

    // --- upload_asset ---
    if (action === "upload_asset") {
      if (!context?.assetStore) throw new Error("Asset store is not configured.");
      const sourceRef = assetRef ?? ref;
      if (!sourceRef) throw new Error("'assetRef' is required when action is 'upload_asset'.");
      if (!path) throw new Error("'path' is required when action is 'upload_asset'.");

      await ensureDir(workspaceRoot);
      const targetPath = resolveWorkspaceFilePath(workspaceRoot, path);
      const assetId = resolveAssetIdForStore(sourceRef, context.assetStore);
      const { bytes, mime } = await context.assetStore.get(assetId);
      const maxBytes = getMaxArtifactBytes();
      if (bytes.byteLength > maxBytes) {
        throw new Error(`Asset exceeds max artifact size of ${maxBytes} bytes.`);
      }
      if (!overwrite) {
        try {
          await Deno.stat(targetPath);
          throw new Error(`Workspace file already exists: ${path}`);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      }

      await ensureDir(dirname(targetPath));
      await Deno.writeFile(targetPath, bytes);
      return {
        success: true,
        action,
        path: normalizeWorkspaceFilePath(path),
        assetRef: buildAssetRefForStore(context.assetStore, assetId),
        mimeType: mime,
        size: bytes.byteLength,
        workspaceRoot,
      };
    }

    // --- export_file ---
    if (action === "export_file") {
      if (!context?.assetStore) throw new Error("Asset store is not configured.");
      if (!path) throw new Error("'path' is required when action is 'export_file'.");

      const sourcePath = resolveWorkspaceFilePath(workspaceRoot, path);
      const info = await Deno.stat(sourcePath);
      if (!info.isFile) throw new Error(`Workspace path is not a file: ${path}`);
      const maxBytes = getMaxArtifactBytes();
      if (info.size > maxBytes) {
        throw new Error(`File exceeds max artifact size of ${maxBytes} bytes.`);
      }

      const bytes = await Deno.readFile(sourcePath);
      const resolvedMime = mimeType ?? "application/octet-stream";
      const { assetId } = await context.assetStore.save(bytes, resolvedMime);
      return {
        success: true,
        action,
        path: normalizeWorkspaceFilePath(path),
        assetRef: buildAssetRefForStore(context.assetStore, assetId),
        mimeType: resolvedMime,
        size: bytes.byteLength,
        workspaceRoot,
      };
    }

    // --- restart ---
    if (action === "restart") {
      await closeSession(key);
      const session = await createSession(
        key,
        workspaceRoot,
        scope,
        namespace,
        project,
        scopedAgentId,
      );
      return {
        success: true,
        sessionKey: key,
        workspaceRoot: session.workspaceRoot,
        message: "Terminal session restarted.",
      };
    }

    // --- run ---
    if (action !== "run" || !command?.trim()) {
      throw new Error("'command' is required when action is 'run'.");
    }

    const unsubscribeCancel = context?.onCancel?.(() => {
      // Close session on cancellation so the read loop stops promptly.
      // This keeps cancellation semantics consistent with other tools.
      closeSession(key).catch(() => undefined);
    });
    if (context?.cancelled) {
      closeSession(key).catch(() => undefined);
    }

    const session = await ensureSession(
      key,
      workspaceRoot,
      scope,
      namespace,
      project,
      scopedAgentId,
    );
    const uuid = crypto.randomUUID();
    const marker = `__COPILOTZ_END_${uuid}__`;

    let fullCommand = "";
    if (cwd) {
      if (cwd.includes("..") || cwd.includes("~")) {
        throw new Error("Directory traversal (.. or ~) is not allowed in cwd.");
      }
      fullCommand += `cd ${shellQuote(cwd)} && `;
    }
    fullCommand += `${command}\n`;
    fullCommand += "__copilotz_exit_code=$?\n";
    fullCommand += `printf "\\n${marker}:%s\\n" "$__copilotz_exit_code"\n`;

    try {
      await session.writer.write(textEncoder.encode(fullCommand));
      const timeoutMs = typeof timeout === "number" ? timeout * 1000 : undefined;
      const result = await readOutputUntil(session, uuid, timeoutMs);
      return {
        output: result.output,
        exitCode: result.exitCode,
      };
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes("timed out") || message.includes("timeout")) {
        await closeSession(key);
        const timeoutText = typeof timeout === "number"
          ? `${timeout}s`
          : "the configured timeout";
        throw new Error(
          `Command timed out after ${timeoutText}. Terminal session was closed. Restart with action='restart' to continue.`,
        );
      }
      throw new Error(`Terminal execution failed: ${message}`);
    } finally {
      unsubscribeCancel?.();
    }
  },
};

export default persistentTerminalTool;
