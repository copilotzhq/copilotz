import type { NewTool } from "@/interfaces/index.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PersistentTerminalParams {
	action: "run" | "info" | "restart" | "close" | "list";
	command?: string;
	cwd?: string;
	timeout?: number;
	scope?: "agent" | "project" | "tenant";
	project?: string;
}

interface ToolContext {
	senderId?: string;
	threadId?: string;
	namespace?: string;
	db?: {
		ops: {
			getThreadById: (id: string) => Promise<
				{ metadata?: Record<string, unknown> | null; externalId?: string | null } | undefined
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

function resolveBaseDir(): string {
	// deno-lint-ignore no-explicit-any
	const denoNs = (globalThis as any).Deno;
	const env = denoNs?.env?.get?.("COPILOTZ_WORKSPACES_DIR");
	if (typeof env === "string" && env.length > 0) return env.replace(/\/+$/, "");
	return `${denoNs?.cwd?.() ?? "."}/workspaces`;
}

function buildWorkspaceRoot(
	namespace: string,
	project: string,
	agentId: string,
	scope: "agent" | "project" | "tenant",
): string {
	const base = resolveBaseDir();
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

function buildSessionKey(
	namespace: string,
	project: string,
	agentId: string,
	scope: "agent" | "project" | "tenant",
): string {
	return `${sanitize(namespace)}:${sanitize(project)}:${sanitize(agentId)}:${scope}`;
}

async function resolveProject(explicit?: string, context?: ToolContext): Promise<string> {
	if (typeof explicit === "string" && explicit.length > 0) return explicit;
	if (!context?.threadId || !context.db?.ops) return "default";
	try {
		const thread = await context.db.ops.getThreadById(context.threadId);
		if (!thread) return context.threadId;
		const meta = thread.metadata as Record<string, unknown> | null;
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
			try { reader.releaseLock(); } catch { /* */ }
		}
	})();
}

async function ensureDir(path: string): Promise<void> {
	// deno-lint-ignore no-explicit-any
	const denoNs = (globalThis as any).Deno;
	if (!denoNs?.mkdir) throw new Error("persistent_terminal requires Deno runtime");
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
	if (!denoNs?.Command) throw new Error("persistent_terminal requires Deno runtime");

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

	try { await session.writer.close(); } catch { /* */ } finally {
		try { session.writer.releaseLock(); } catch { /* */ }
	}

	const statusPromise = session.process.status.catch(() => undefined);
	try { session.process.kill(); } catch { /* */ }

	const exited = await Promise.race([
		statusPromise.then(() => true),
		sleep(500).then(() => false),
	]);
	if (!exited) {
		try { session.process.kill("SIGKILL"); } catch { /* */ }
	}

	await Promise.allSettled([statusPromise, session.stdoutPump, session.stderrPump]);
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
	timeoutMs: number,
): Promise<{ output: string; exitCode: number | null }> {
	const markerPrefix = `__COPILOTZ_END_${uuid}__:`;
	const deadline = Date.now() + timeoutMs;

	while (Date.now() <= deadline) {
		const idx = session.outputBuffer.indexOf(markerPrefix);
		if (idx !== -1) {
			const lineEnd = session.outputBuffer.indexOf("\n", idx);
			if (lineEnd === -1) { await sleep(25); continue; }

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

	throw new Error(`Command timed out after ${timeoutMs / 1000} seconds`);
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
				enum: ["run", "info", "restart", "close", "list"],
				description:
					"'run': execute a command. 'info': show current session details. " +
					"'restart': kill and recreate the session. 'close': terminate the session. " +
					"'list': show all active sessions for the current scope.",
			},
			command: {
				type: "string",
				description: "Bash command to execute (required when action is 'run').",
			},
			cwd: {
				type: "string",
				description: "Directory to cd into before running the command (relative to workspace root). Must stay inside the workspace.",
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
				description:
					"Workspace isolation level. " +
					"'agent': private workspace for this agent. " +
					"'project': shared workspace across agents in the same project/thread. " +
					"'tenant': shared workspace across all projects for the namespace/tenant.",
			},
			project: {
				type: "string",
				description:
					"Explicit project name for the workspace. " +
					"Overrides automatic resolution from thread metadata. " +
					"Use this to target a specific project workspace regardless of the current thread.",
			},
		},
		required: ["action"],
	},
	execute: async (
		{ action, command, cwd, timeout = 30, scope = "agent", project: explicitProject }: PersistentTerminalParams,
		context?: ToolContext,
	) => {
		const namespace = context?.namespace ?? "default";
		const agentId = context?.senderId ?? "anonymous";
		const project = await resolveProject(explicitProject, context);

		const key = buildSessionKey(namespace, project, agentId, scope);
		const workspaceRoot = buildWorkspaceRoot(namespace, project, agentId, scope);

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
			return { success: true, message: "Terminal session closed.", sessionKey: key };
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
				agentId,
				workspaceRoot,
				startedAt: session?.startedAt ?? null,
			};
		}

		// --- restart ---
		if (action === "restart") {
			await closeSession(key);
			const session = await createSession(key, workspaceRoot, scope, namespace, project, agentId);
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

		const session = await ensureSession(key, workspaceRoot, scope, namespace, project, agentId);
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
			const result = await readOutputUntil(session, uuid, timeout * 1000);
			return {
				success: true,
				sessionKey: key,
				scope,
				namespace,
				project,
				agentId,
				workspaceRoot: session.workspaceRoot,
				command,
				output: result.output,
				exitCode: result.exitCode,
				commandSucceeded: result.exitCode === 0,
			};
		} catch (error) {
			const message = (error as Error).message;
			if (message.includes("timed out") || message.includes("timeout")) {
				await closeSession(key);
				throw new Error(
					`Command timed out after ${timeout}s. Terminal session was closed. Restart with action='restart' to continue.`,
				);
			}
			throw new Error(`Terminal execution failed: ${message}`);
		}
	},
};

export default persistentTerminalTool;
