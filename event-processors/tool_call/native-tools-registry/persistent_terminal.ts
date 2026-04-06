// @ts-ignore: We'll implement typing implicitly
import type { NewTool } from "@/interfaces/index.ts";

interface PersistentTerminalParams {
    action: "run" | "close" | "restart";
    command?: string;
    cwd?: string;
    timeout?: number;
}

// In-memory registry to hold the persistent terminal process
interface TerminalSession {
    process: Deno.ChildProcess;
    writer: WritableStreamDefaultWriter<Uint8Array>;
    reader: ReadableStreamDefaultReader<Uint8Array>;
    outputBuffer: string;
}

let activeSession: TerminalSession | null = null;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Ensures a terminal session is active.
 */
function ensureSession(): TerminalSession {
    if (!activeSession) {
        // We use denoNs dynamic lookup to avoid build errors in non-Deno environments
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
        
        // Combine stdout and stderr into a single stream reader for simplicity?
        // Deno doesn't easily let us merge them without piping, so we'll just read stdout for now,
        // or we redirect stderr to stdout in bash itself! We can't do that at the Deno level easily 
        // without a custom TransformStream. Wait, if we use `bash`, we can just tell bash to redirect 
        // when executing the command! Wait, `Deno.Command` gives us `stderr` too.
        
        activeSession = {
            process: childProcess,
            writer: childProcess.stdin.getWriter(),
            reader: childProcess.stdout.getReader(),
            outputBuffer: "",
        };

        // We also want to continuously read stderr in background so it doesn't block the pipe.
        // We'll read it and dump it into `outputBuffer`.
        const stderrReader = childProcess.stderr.getReader();
        (async () => {
            try {
                while (true) {
                    const { value, done } = await stderrReader.read();
                    if (done) break;
                    if (activeSession) {
                        activeSession.outputBuffer += textDecoder.decode(value);
                    }
                }
            } catch (_e) {
                // Ignore background read errors
            } finally {
                stderrReader.releaseLock();
            }
        })();
    }
    return activeSession;
}

/**
 * Closes the active session
 */
async function closeSession() {
    if (activeSession) {
        try {
            await activeSession.writer.close();
            activeSession.reader.releaseLock();
            // In Deno, you might have to kill the process if it doesn't exit on stdin close
            try {
                activeSession.process.kill();
            } catch (_e) {
                // Ignore if already dead
            }
        } catch (_e) {
            // Ignore errors on close
        }
        activeSession = null;
    }
}

function readOutputUntil(session: TerminalSession, uuid: string, timeoutMs: number): Promise<string> {
    const marker = `__COPILOTZ_END_${uuid}__`;
    const deadline = Date.now() + timeoutMs;
    
    return new Promise((resolve, reject) => {
        let isDone = false;
        
        const checkTimeout = setInterval(() => {
            if (Date.now() > deadline) {
                isDone = true;
                clearInterval(checkTimeout);
                session.reader.releaseLock(); // Careful: releasing lock in middle of read can throw
                reject(new Error(`Command timeout after ${timeoutMs / 1000} seconds`));
            }
        }, 100);

        const readLoop = async () => {
            try {
                while (!isDone) {
                    // Check if buffer already has the marker
                    if (session.outputBuffer.includes(marker)) {
                        isDone = true;
                        break;
                    }

                    // Wait for more data from stdout
                    const { value, done } = await session.reader.read();
                    if (done) {
                        isDone = true;
                        break;
                    }
                    session.outputBuffer += textDecoder.decode(value);
                }
                
                clearInterval(checkTimeout);
                
                // Extract the result from the buffer
                const parts = session.outputBuffer.split(marker);
                const finalOutput = parts[0].trim();
                // Keep whatever came after the marker in the buffer
                session.outputBuffer = parts.slice(1).join(marker);
                
                resolve(finalOutput);
            } catch (err) {
                clearInterval(checkTimeout);
                reject(err);
            }
        };
        
        readLoop();
    });
}

const persistentTerminalTool: NewTool = {
    key: "persistent_terminal",
    name: "Persistent Terminal",
    description: "Access a persistent bash terminal. Maintains state (like current directory and variables) between executions. Use this for complex bash scripts, pipes, or stateful commands.",
    inputSchema: {
        type: "object",
        properties: {
            action: {
                type: "string",
                description: "Action to perform: 'run' to execute a command, 'restart' to restart the terminal, or 'close' to terminate the session.",
                enum: ["run", "restart", "close"],
            },
            command: {
                type: "string",
                description: "The bash command to execute (if action is 'run'). Can contain pipes, redirects, etc.",
            },
            cwd: {
                type: "string",
                description: "Optional working directory to change to before running the command.",
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
            
            let fullCommand = "";
            if (cwd) {
                // Prepend a cd command if cwd is provided
                // Security check for cwd traversal
                if (cwd.includes("..") || cwd.includes("~")) {
                    throw new Error("Directory traversal not allowed in cwd");
                }
                fullCommand += `cd "${cwd}" && `;
            }
            
            // We append the echo command to signify completion.
            // We redirect stderr to stdout (2>&1) for this command so our marker comes *after* any stderr output.
            // Wait, but we still capture ambient stderr via the background reader.
            fullCommand += `{ ${command}; } 2>&1\necho "__COPILOTZ_END_${uuid}__"\n`;

            try {
                await session.writer.write(textEncoder.encode(fullCommand));
                const output = await readOutputUntil(session, uuid, timeoutMs);
                return {
                    command,
                    output,
                    success: true,
                };
            } catch (error) {
                if ((error as Error).message.includes("timeout")) {
                    // Try to restart session if timeout occurs so it's not permanently wedged
                    await closeSession();
                    throw new Error(`Command timeout after ${timeout} seconds. The terminal session was restarted.`);
                }
                throw new Error(`Terminal execution failed: ${(error as Error).message}`);
            }
        }

        throw new Error("Invalid parameters provided to persistent_terminal.");
    },
};

export default persistentTerminalTool;
