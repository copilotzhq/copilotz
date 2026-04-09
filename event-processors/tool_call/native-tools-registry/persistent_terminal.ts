// @ts-ignore: We'll implement typing implicitly
import type { NewTool } from "@/interfaces/index.ts";

interface PersistentTerminalParams {
    action: "run" | "close" | "restart";
    command?: string;
    cwd?: string;
    timeout?: number;
}

interface TerminalSession {
    process: Deno.ChildProcess;
    writer: WritableStreamDefaultWriter<Uint8Array>;
    outputBuffer: string;
    stdoutPump: Promise<void>;
    stderrPump: Promise<void>;
    closed: boolean;
}

let activeSession: TerminalSession | null = null;
const textEncoder = new TextEncoder();
const MAX_OUTPUT_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
    return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

function startStreamPump(
    session: TerminalSession,
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
            if (tail && !session.closed) {
                session.outputBuffer += tail;
            }
        } catch (_e) {
            // Ignore background read errors during shutdown.
        } finally {
            try {
                reader.releaseLock();
            } catch (_e) {
                // Ignore lock release errors.
            }
        }
    })();
}

function ensureSession(): TerminalSession {
    if (!activeSession) {
        // deno-lint-ignore no-explicit-any
        const denoNs = (globalThis as any).Deno;
        if (!denoNs?.Command) {
            throw new Error("persistent_terminal tool requires Deno runtime");
        }

        const cmd = new denoNs.Command("bash", {
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
        });

        const childProcess = cmd.spawn();
        const session: TerminalSession = {
            process: childProcess,
            writer: childProcess.stdin.getWriter(),
            outputBuffer: "",
            stdoutPump: Promise.resolve(),
            stderrPump: Promise.resolve(),
            closed: false,
        };

        session.stdoutPump = startStreamPump(session, childProcess.stdout);
        session.stderrPump = startStreamPump(session, childProcess.stderr);
        activeSession = session;
    }

    return activeSession;
}

async function closeSession() {
    const session = activeSession;
    if (!session) {
        return;
    }

    activeSession = null;
    session.closed = true;

    try {
        await session.writer.close();
    } catch (_e) {
        // Ignore close errors.
    } finally {
        try {
            session.writer.releaseLock();
        } catch (_e) {
            // Ignore lock release errors.
        }
    }

    const statusPromise = session.process.status.catch(() => undefined);

    try {
        session.process.kill();
    } catch (_e) {
        // Ignore if already dead.
    }

    const exited = await Promise.race([
        statusPromise.then(() => true),
        sleep(500).then(() => false),
    ]);

    if (!exited) {
        try {
            session.process.kill("SIGKILL");
        } catch (_e) {
            // Ignore if force-kill is unsupported or unnecessary.
        }
    }

    await statusPromise;
    await Promise.allSettled([session.stdoutPump, session.stderrPump]);
}

async function readOutputUntil(
    session: TerminalSession,
    uuid: string,
    timeoutMs: number,
): Promise<{ output: string; exitCode: number | null }> {
    const markerPrefix = `__COPILOTZ_END_${uuid}__:`;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() <= deadline) {
        const markerIndex = session.outputBuffer.indexOf(markerPrefix);
        if (markerIndex !== -1) {
            const lineEnd = session.outputBuffer.indexOf("\n", markerIndex);
            if (lineEnd === -1) {
                await sleep(25);
                continue;
            }

            const output = session.outputBuffer.slice(0, markerIndex).trimEnd();
            const markerLine = session.outputBuffer.slice(markerIndex, lineEnd).trim();
            session.outputBuffer = session.outputBuffer.slice(lineEnd + 1);

            const exitCodeText = markerLine.slice(markerPrefix.length).trim();
            const parsedExitCode = Number.parseInt(exitCodeText, 10);

            return {
                output,
                exitCode: Number.isNaN(parsedExitCode) ? null : parsedExitCode,
            };
        }

        if (session.closed) {
            throw new Error("Terminal session ended unexpectedly");
        }

        await sleep(25);
    }

    throw new Error(`Command timeout after ${timeoutMs / 1000} seconds`);
}

const persistentTerminalTool: NewTool = {
    key: "persistent_terminal",
    name: "Persistent Terminal",
    description:
        "Access a persistent bash terminal. Maintains state (like current directory and variables) between executions. Use this for complex bash scripts, pipes, or stateful commands.",
    inputSchema: {
        type: "object",
        properties: {
            action: {
                type: "string",
                description:
                    "Action to perform: 'run' to execute a command, 'restart' to restart the terminal, or 'close' to terminate the session.",
                enum: ["run", "restart", "close"],
            },
            command: {
                type: "string",
                description:
                    "The bash command to execute (if action is 'run'). Can contain pipes, redirects, etc.",
            },
            cwd: {
                type: "string",
                description:
                    "Optional working directory to change to before running the command.",
            },
            timeout: {
                type: "number",
                description: "Timeout in seconds for the command execution.",
                default: 30,
                minimum: 1,
                maximum: 300,
            },
        },
        required: ["action"],
    },
    execute: async ({ action, command, cwd, timeout = 30 }: PersistentTerminalParams) => {
        if (action === "close") {
            await closeSession();
            return { success: true, message: "Terminal closed." };
        }

        if (action === "restart") {
            await closeSession();
            ensureSession();
            return { success: true, message: "Terminal restarted." };
        }

        if (action === "run" && typeof command === "string") {
            const session = ensureSession();
            const timeoutMs = timeout * 1000;
            const uuid = crypto.randomUUID();
            const marker = `__COPILOTZ_END_${uuid}__`;

            let fullCommand = "";
            if (cwd) {
                if (cwd.includes("..") || cwd.includes("~")) {
                    throw new Error("Directory traversal not allowed in cwd");
                }
                fullCommand += `cd ${shellQuote(cwd)} && `;
            }

            fullCommand += `${command}\n`;
            fullCommand += "__copilotz_exit_code=$?\n";
            fullCommand += `printf "\\n${marker}:%s\\n" "$__copilotz_exit_code"\n`;

            try {
                await session.writer.write(textEncoder.encode(fullCommand));
                const result = await readOutputUntil(session, uuid, timeoutMs);
                return {
                    command,
                    output: result.output,
                    exitCode: result.exitCode,
                    commandSucceeded: result.exitCode === 0,
                    success: true,
                };
            } catch (error) {
                const message = (error as Error).message;
                if (message.includes("timeout")) {
                    await closeSession();
                    throw new Error(
                        `Command timeout after ${timeout} seconds. The terminal session was closed.`,
                    );
                }
                throw new Error(`Terminal execution failed: ${message}`);
            }
        }

        throw new Error("Invalid parameters provided to persistent_terminal.");
    },
};

export default persistentTerminalTool;
