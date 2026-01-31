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
    execute: async ({ command, args = [], cwd = ".", timeout = 30 }: RunCommandParams) => {
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
            
            // Create command with timeout
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
            
            // Set up timeout
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error(`Command timeout after ${timeout} seconds`)), timeout * 1000);
            });
            
            // Execute command with timeout
            const result = await Promise.race([
                cmd.output(),
                timeoutPromise
            ]) as unknown as { code: number; success: boolean; stdout: Uint8Array; stderr: Uint8Array };
            
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
        } catch (error) {
            if ((error as Error).message.includes("timeout")) {
                throw error; // Re-throw timeout errors as-is
            }
            throw new Error(`Command execution failed: ${(error as Error).message}`);
        }
    },
}