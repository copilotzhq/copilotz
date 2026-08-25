/**
 * Implements the Deno persistent-terminal service Adapter.
 *
 * @module
 */

import {
  dirname,
  isAbsolute,
  relative,
  resolve,
} from "../../../../dependencies/std-path.ts";
import type {
  PersistentTerminalInput,
  PersistentTerminalScope,
  PersistentTerminalService,
  PersistentTerminalServiceContext,
} from "../../actions/persistent-terminal/index.ts";

export type CreatePersistentTerminalServiceOptions = Readonly<{
  /** Explicit isolated workspace tree. Defaults to COPILOTZ_WORKSPACES_DIR. */
  workspaceBase?: string | null;
  /** Shared filesystem root when workspaceBase is absent. Defaults to cwd. */
  projectRoot?: string;
  shell?: string;
  maxOutputBytes?: number;
  maxArtifactBytes?: number;
  now?: () => Date;
  createId?: () => string;
}>;

type SessionRecord = {
  process: Deno.ChildProcess;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  output: string;
  stdoutPump: Promise<void>;
  stderrPump: Promise<void>;
  commandTail: Promise<void>;
  closed: boolean;
  workspaceRoot: string;
  scope: PersistentTerminalScope;
  namespace: string;
  project: string;
  agentId: string;
  startedAt: string;
};

const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const encoder = new TextEncoder();

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(name + " must be a positive safe integer.");
  }
  return resolved;
}

function optionalEnvironment(name: string): string | undefined {
  try {
    return Deno.env.get(name)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function configuredWorkspaceBase(
  options: CreatePersistentTerminalServiceOptions,
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(options, "workspaceBase")) {
    return options.workspaceBase?.trim() || undefined;
  }
  return optionalEnvironment("COPILOTZ_WORKSPACES_DIR");
}

function configuredArtifactLimit(
  options: CreatePersistentTerminalServiceOptions,
): number {
  if (options.maxArtifactBytes !== undefined) {
    return positiveInteger(
      options.maxArtifactBytes,
      DEFAULT_MAX_ARTIFACT_BYTES,
      "maxArtifactBytes",
    );
  }
  const configured = Number(optionalEnvironment("COPILOTZ_MAX_ARTIFACT_BYTES"));
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_ARTIFACT_BYTES;
}

function sanitize(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "-").slice(0, 128) ||
    "unknown";
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function scopedAgentId(
  agentId: string,
  scope: PersistentTerminalScope,
): string {
  if (scope === "tenant") return "__tenant__";
  if (scope === "project") return "__project__";
  return agentId;
}

function scopedProject(
  project: string,
  scope: PersistentTerminalScope,
): string {
  return scope === "tenant" ? "__tenant__" : project;
}

export function buildPersistentTerminalSessionKey(
  namespace: string,
  project: string,
  agentId: string,
  scope: PersistentTerminalScope,
): string {
  return [
    sanitize(namespace),
    sanitize(scopedProject(project, scope)),
    sanitize(scopedAgentId(agentId, scope)),
    scope,
  ].join(":");
}

export function buildTerminalWorkspaceRoot(
  input: Readonly<{
    namespace: string;
    project: string;
    agentId: string;
    scope: PersistentTerminalScope;
    workspaceBase?: string;
    projectRoot: string;
  }>,
): string {
  if (!input.workspaceBase) return resolve(input.projectRoot);
  const base = resolve(input.workspaceBase);
  if (input.scope === "tenant") {
    return resolve(base, sanitize(input.namespace));
  }
  if (input.scope === "project") {
    return resolve(
      base,
      sanitize(input.namespace),
      sanitize(input.project),
    );
  }
  return resolve(
    base,
    sanitize(input.namespace),
    sanitize(input.project),
    sanitize(input.agentId),
  );
}

export function normalizeTerminalFilePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    !normalized || normalized === "." || normalized.endsWith("/") ||
    normalized.includes("\0") || normalized.includes("~") ||
    isAbsolute(normalized) || normalized.split("/").includes("..")
  ) {
    throw new TypeError("Workspace file path must be a relative file path.");
  }
  return normalized.split("/").filter((part) => part && part !== ".").join(
    "/",
  );
}

export function resolveTerminalFilePath(
  workspaceRoot: string,
  value: string,
): string {
  const root = resolve(workspaceRoot);
  const target = resolve(root, normalizeTerminalFilePath(value));
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new TypeError("Workspace file path escapes the terminal root.");
  }
  return target;
}

function resolveTerminalDirectory(
  workspaceRoot: string,
  value: string,
): string {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized === ".") return resolve(workspaceRoot);
  if (
    normalized.includes("\0") || normalized.includes("~") ||
    isAbsolute(normalized) || normalized.split("/").includes("..")
  ) {
    throw new TypeError("Terminal cwd must remain inside the workspace root.");
  }
  const root = resolve(workspaceRoot);
  const target = resolve(root, normalized);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new TypeError("Terminal cwd escapes the workspace root.");
  }
  return target;
}

function scopeFrom(
  value: PersistentTerminalScope | undefined,
): PersistentTerminalScope {
  const scope = value ?? "agent";
  if (!(["agent", "project", "tenant"] as const).includes(scope)) {
    throw new TypeError("Unknown persistent terminal scope '" + scope + "'.");
  }
  return scope;
}

function boundedTimeout(value: number | undefined): number {
  const timeout = value ?? 30;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 300) {
    throw new TypeError("Terminal timeout must be between 1 and 300 seconds.");
  }
  return timeout * 1_000;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/** Creates a worker-local Deno shell service. The caller owns shutdown. */
export function createPersistentTerminalService(
  options: CreatePersistentTerminalServiceOptions = {},
): PersistentTerminalService {
  const isolatedBase = configuredWorkspaceBase(options);
  const projectRoot = resolve(options.projectRoot ?? Deno.cwd());
  const shell = options.shell?.trim() || "bash";
  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES,
    "maxOutputBytes",
  );
  const maxArtifactBytes = configuredArtifactLimit(options);
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? (() => crypto.randomUUID());
  const sessions = new Map<string, SessionRecord>();
  let closed = false;

  const appendOutput = (session: SessionRecord, value: string) => {
    session.output += value;
    if (encoder.encode(session.output).byteLength <= maxOutputBytes) return;
    session.output = session.output.slice(-maxOutputBytes);
  };

  const pump = (
    session: SessionRecord,
    stream: ReadableStream<Uint8Array>,
  ): Promise<void> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    return (async () => {
      try {
        while (!session.closed) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.length) {
            appendOutput(session, decoder.decode(value, { stream: true }));
          }
        }
        const tail = decoder.decode();
        if (tail && !session.closed) appendOutput(session, tail);
      } catch {
        // Closing a terminal intentionally interrupts its output streams.
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // The stream may already have released its reader during shutdown.
        }
      }
    })();
  };

  const createSession = async (
    key: string,
    workspaceRoot: string,
    scope: PersistentTerminalScope,
    context: PersistentTerminalServiceContext,
    project: string,
  ): Promise<SessionRecord> => {
    if (closed) throw new Error("Persistent terminal service is shut down.");
    await Deno.mkdir(workspaceRoot, { recursive: true });
    const child = new Deno.Command(shell, {
      cwd: workspaceRoot,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const session: SessionRecord = {
      process: child,
      writer: child.stdin.getWriter(),
      output: "",
      stdoutPump: Promise.resolve(),
      stderrPump: Promise.resolve(),
      commandTail: Promise.resolve(),
      closed: false,
      workspaceRoot,
      scope,
      namespace: context.namespace,
      project,
      agentId: scopedAgentId(context.agentId, scope),
      startedAt: now().toISOString(),
    };
    session.stdoutPump = pump(session, child.stdout);
    session.stderrPump = pump(session, child.stderr);
    sessions.set(key, session);
    return session;
  };

  const closeSession = async (key: string): Promise<void> => {
    const session = sessions.get(key);
    if (!session) return;
    sessions.delete(key);
    session.closed = true;
    try {
      await session.writer.close();
    } catch {
      // A process may close stdin before the runtime owns shutdown.
    } finally {
      try {
        session.writer.releaseLock();
      } catch {
        // The writer may already be released.
      }
    }
    const status = session.process.status.catch(() => undefined);
    try {
      session.process.kill("SIGTERM");
    } catch {
      // The process may already have exited.
    }
    const exited = await Promise.race([
      status.then(() => true),
      delay(500).then(() => false),
    ]);
    if (!exited) {
      try {
        session.process.kill("SIGKILL");
      } catch {
        // The process may exit between the timeout and signal.
      }
    }
    await Promise.allSettled([status, session.stdoutPump, session.stderrPump]);
  };

  const ensureSession = async (
    key: string,
    workspaceRoot: string,
    scope: PersistentTerminalScope,
    context: PersistentTerminalServiceContext,
    project: string,
  ): Promise<SessionRecord> => {
    const existing = sessions.get(key);
    if (existing && !existing.closed) return existing;
    if (existing) await closeSession(key);
    return await createSession(key, workspaceRoot, scope, context, project);
  };

  const readUntilMarker = async (
    session: SessionRecord,
    marker: string,
    timeoutMs: number,
  ): Promise<Readonly<{ output: string; exitCode: number | null }>> => {
    const prefix = marker + ":";
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const index = session.output.indexOf(prefix);
      if (index >= 0) {
        const lineEnd = session.output.indexOf("\n", index);
        if (lineEnd < 0) {
          await delay(20);
          continue;
        }
        const output = session.output.slice(0, index).trimEnd();
        const exitText = session.output.slice(
          index + prefix.length,
          lineEnd,
        ).trim();
        session.output = session.output.slice(lineEnd + 1);
        const exitCode = Number.parseInt(exitText, 10);
        return Object.freeze({
          output,
          exitCode: Number.isNaN(exitCode) ? null : exitCode,
        });
      }
      if (session.closed) {
        throw new Error("Terminal session ended unexpectedly.");
      }
      await delay(20);
    }
    throw new Error(
      "Command timed out after " + timeoutMs / 1_000 + " seconds.",
    );
  };

  const enqueue = <T>(
    session: SessionRecord,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const result = session.commandTail.then(operation);
    session.commandTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const execute = async (
    input: PersistentTerminalInput,
    context: PersistentTerminalServiceContext,
  ): Promise<unknown> => {
    if (closed) throw new Error("Persistent terminal service is shut down.");
    context.signal.throwIfAborted();
    const scope = scopeFrom(input.scope);
    const project = input.project?.trim() || context.project;
    if (!project.trim()) throw new TypeError("Terminal project is required.");
    const key = buildPersistentTerminalSessionKey(
      context.namespace,
      project,
      context.agentId,
      scope,
    );
    const workspaceRoot = buildTerminalWorkspaceRoot({
      namespace: context.namespace,
      project,
      agentId: context.agentId,
      scope,
      workspaceBase: isolatedBase,
      projectRoot,
    });

    if (input.action === "list") {
      const activeSessions = [...sessions.entries()].filter(([, session]) =>
        session.namespace === context.namespace && !session.closed
      ).map(([sessionKey, session]) =>
        Object.freeze({
          sessionKey,
          scope: session.scope,
          namespace: session.namespace,
          project: session.project,
          agentId: session.agentId,
          workspaceRoot: session.workspaceRoot,
          startedAt: session.startedAt,
        })
      );
      return Object.freeze({
        success: true,
        activeSessions: Object.freeze(activeSessions),
        count: activeSessions.length,
      });
    }

    if (input.action === "close") {
      await closeSession(key);
      return Object.freeze({
        success: true,
        message: "Terminal session closed.",
        sessionKey: key,
      });
    }

    if (input.action === "info") {
      const session = sessions.get(key);
      return Object.freeze({
        success: true,
        sessionKey: key,
        exists: Boolean(session && !session.closed),
        scope,
        namespace: context.namespace,
        project,
        agentId: scopedAgentId(context.agentId, scope),
        workspaceRoot,
        startedAt: session?.startedAt ?? null,
      });
    }

    if (input.action === "upload_asset") {
      const sourceRef = input.assetRef ?? input.ref;
      if (!sourceRef?.trim()) {
        throw new TypeError("assetRef is required for upload_asset.");
      }
      if (!input.path?.trim()) {
        throw new TypeError("path is required for upload_asset.");
      }
      const asset = await context.readAsset(sourceRef);
      if (asset.bytes.byteLength > maxArtifactBytes) {
        throw new Error(
          "Asset exceeds max artifact size of " + maxArtifactBytes + " bytes.",
        );
      }
      const target = resolveTerminalFilePath(workspaceRoot, input.path);
      if (!input.overwrite) {
        try {
          await Deno.stat(target);
          throw new Error("Workspace file already exists: " + input.path);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      }
      await Deno.mkdir(dirname(target), { recursive: true });
      await Deno.writeFile(target, asset.bytes);
      return Object.freeze({
        success: true,
        action: input.action,
        path: normalizeTerminalFilePath(input.path),
        assetRef: asset.assetRef,
        mimeType: asset.mediaType,
        size: asset.bytes.byteLength,
        workspaceRoot,
      });
    }

    if (input.action === "export_file") {
      if (!input.path?.trim()) {
        throw new TypeError("path is required for export_file.");
      }
      const source = resolveTerminalFilePath(workspaceRoot, input.path);
      const info = await Deno.stat(source);
      if (!info.isFile) {
        throw new Error("Workspace path is not a file: " + input.path);
      }
      if (info.size > maxArtifactBytes) {
        throw new Error(
          "File exceeds max artifact size of " + maxArtifactBytes + " bytes.",
        );
      }
      const normalizedPath = normalizeTerminalFilePath(input.path);
      const bytes = await Deno.readFile(source);
      const mediaType = input.mimeType?.trim() || "application/octet-stream";
      const published = await context.publishAsset({
        bytes,
        mediaType,
        name: normalizedPath,
        operationKey: "export:" + key + ":" + normalizedPath,
      });
      return Object.freeze({
        success: true,
        action: input.action,
        path: normalizedPath,
        ...published,
        size: published.byteLength,
        workspaceRoot,
      });
    }

    if (input.action === "restart") {
      await closeSession(key);
      const session = await createSession(
        key,
        workspaceRoot,
        scope,
        context,
        project,
      );
      return Object.freeze({
        success: true,
        sessionKey: key,
        workspaceRoot: session.workspaceRoot,
        message: "Terminal session restarted.",
      });
    }

    if (input.action !== "run" || !input.command?.trim()) {
      throw new TypeError("command is required for the run action.");
    }
    const session = await ensureSession(
      key,
      workspaceRoot,
      scope,
      context,
      project,
    );
    const timeoutMs = boundedTimeout(input.timeout);
    const abort = () => {
      void closeSession(key);
    };
    context.signal.addEventListener("abort", abort, { once: true });
    try {
      return await enqueue(session, async () => {
        context.signal.throwIfAborted();
        const marker = "__COPILOTZ_END_" + sanitize(createId()) + "__";
        const cwd = input.cwd
          ? resolveTerminalDirectory(workspaceRoot, input.cwd)
          : undefined;
        const command = [
          ...(cwd ? ["cd " + shellQuote(cwd) + " || exit $?"] : []),
          input.command!,
          "__copilotz_exit_code=$?",
          'printf "\\n' + marker + ':%s\\n" "$__copilotz_exit_code"',
        ].join("\n") + "\n";
        try {
          await session.writer.write(encoder.encode(command));
          return await readUntilMarker(session, marker, timeoutMs);
        } catch (error) {
          await closeSession(key);
          throw error;
        }
      });
    } finally {
      context.signal.removeEventListener("abort", abort);
    }
  };

  return Object.freeze({
    execute,
    async shutdown(_reason = "persistent_terminal_shutdown") {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...sessions.keys()].map(closeSession));
    },
  });
}
