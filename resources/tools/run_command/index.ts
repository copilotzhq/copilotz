interface RunCommandParams {
    command: string;
    args?: string[];
    cwd?: string;
    timeout?: number;
}

export default {
    key: "run_command",
    name: "Run Command",
    description: "Execute a system command safely with timeout protection.",
    inputSchema: {
        type: "object",
        properties: {
            command: { type: "string", description: "Command to execute." },
            args: {
                type: "array",
                items: { type: "string" },
                description: "Command arguments.",
                default: []
            },
            cwd: {
                type: "string",
                description: "Working directory for command execution.",
                default: "."
            },
            timeout: {
                type: "number",
                description: "Timeout in seconds.",
                default: 30,
                minimum: 1,
                maximum: 300
            },
        },
        required: ["command"],
    },
    execute: async (
        { command, args = [], cwd = ".", timeout }: RunCommandParams,
        context?: { onCancel?: (cb: () => void) => () => void; cancelled?: boolean },
    ) => {
        try {
            // Security check - block dangerous commands
            const dangerousCommands = ["rm", "del", "format", "mkfs", "dd", "fdisk"];
            if (dangerousCommands.includes(command.toLowerCase())) {
                throw new Error(`Dangerous command blocked: ${command}`);
            }
            
            // Security check for working directory
            if (cwd.includes("..") || cwd.includes("~")) {
                throw new Error("Directory traversal not allowed in cwd");
            }
            
            // Create command (cancellation is handled by killing the spawned process)
            const denoNs = (globalThis as unknown as { Deno?: { Command?: new (cmd: string, opts: { args?: string[]; cwd?: string; stdout?: "piped" | "inherit" | "null"; stderr?: "piped" | "inherit" | "null" }) => { output: () => Promise<{ code: number; success: boolean; stdout: Uint8Array; stderr: Uint8Array }> } } }).Deno;
            if (!denoNs?.Command) {
                throw new Error("run_command tool requires Deno runtime");
            }
            const cmd = new denoNs.Command(command, {
                args,
                cwd,
                stdout: "piped",
                stderr: "piped",
            });

            // Use spawn() so we can kill the child on cancellation/timeout
            // deno-lint-ignore no-explicit-any
            const child = (cmd as any).spawn?.() as Deno.ChildProcess;
            if (!child) {
                // Fallback for older runtimes
                const result = await cmd.output();
                const stdout = new TextDecoder().decode(result.stdout);
                const stderr = new TextDecoder().decode(result.stderr);
                return {
                    command,
                    args,
                    cwd,
                    stdout,
                    stderr,
                    exitCode: result.code,
                    success: result.success,
                };
            }

            const killChild = (signal?: Deno.Signal) => {
                try {
                    child.kill(signal);
                } catch {
                    /* ignore */
                }
            };

            const unsubscribe = context?.onCancel?.(() => {
                killChild("SIGTERM");
                setTimeout(() => killChild("SIGKILL"), 500);
            });

            if (context?.cancelled) {
                killChild("SIGTERM");
                setTimeout(() => killChild("SIGKILL"), 500);
            }

            const timeoutMs = typeof timeout === "number" && timeout > 0 ? timeout * 1000 : undefined;
            const timeoutPromise = typeof timeoutMs === "number"
                ? new Promise<never>((_, reject) => {
                    const id = setTimeout(() => {
                        killChild("SIGTERM");
                        setTimeout(() => killChild("SIGKILL"), 500);
                        reject(new Error(`Command timeout after ${timeout} seconds`));
                    }, timeoutMs);
                    // Ensure we clear if the process ends first
                    child.status.finally(() => clearTimeout(id)).catch(() => clearTimeout(id));
                })
                : null;

            const statusPromise = child.status;
            const stdoutPromise = child.stdout
                ? new Response(child.stdout).arrayBuffer().then((b) => new Uint8Array(b))
                : Promise.resolve(new Uint8Array());
            const stderrPromise = child.stderr
                ? new Response(child.stderr).arrayBuffer().then((b) => new Uint8Array(b))
                : Promise.resolve(new Uint8Array());

            const result = (timeoutPromise
                ? await Promise.race([
                    Promise.all([statusPromise, stdoutPromise, stderrPromise]),
                    timeoutPromise,
                ])
                : await Promise.all([statusPromise, stdoutPromise, stderrPromise])) as unknown as [
                { code: number; success: boolean },
                Uint8Array,
                Uint8Array,
            ];

            const status = result[0];
            const stdout = new TextDecoder().decode(result[1]);
            const stderr = new TextDecoder().decode(result[2]);
            unsubscribe?.();
            
            return {
                command,
                args,
                cwd,
                stdout,
                stderr,
                exitCode: status.code,
                success: status.success,
            };
        } catch (error) {
            if ((error as Error).message.includes("timeout")) {
                throw error; // Re-throw timeout errors as-is
            }
            throw new Error(`Command execution failed: ${(error as Error).message}`);
        }
    },
}
