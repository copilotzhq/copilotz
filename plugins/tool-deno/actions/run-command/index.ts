/**
 * Defines the bounded Run Command Action.
 *
 * @module
 */

import { type ActionContext, defineAction } from "@copilotz/copilotz/actions";

interface RunCommandParams {
  command: string;
  args?: string[];
  cwd?: string;
  timeout?: number;
}

export const runCommandAction = defineAction({
  id: "copilotz.tools.deno.run_command",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Command to execute." },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Command arguments.",
        default: [],
      },
      cwd: {
        type: "string",
        description: "Working directory for command execution.",
        default: ".",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds.",
        default: 30,
        minimum: 1,
        maximum: 300,
      },
    },
    required: ["command"],
  },
  execute: async (
    { command, args = [], cwd = ".", timeout }: RunCommandParams,
    context: ActionContext,
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
      const denoNs = (globalThis as unknown as {
        Deno?: {
          Command?: new (
            cmd: string,
            opts: {
              args?: string[];
              cwd?: string;
              stdout?: "piped" | "inherit" | "null";
              stderr?: "piped" | "inherit" | "null";
            },
          ) => {
            output: () => Promise<
              {
                code: number;
                success: boolean;
                stdout: Uint8Array;
                stderr: Uint8Array;
              }
            >;
          };
        };
      }).Deno;
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

      let cancel!: () => void;
      const cancellationPromise = new Promise<never>((_, reject) => {
        cancel = () => {
          killChild("SIGTERM");
          setTimeout(() => killChild("SIGKILL"), 500);
          const reason = context.signal.reason;
          reject(
            reason instanceof DOMException && reason.name === "AbortError"
              ? reason
              : new DOMException(
                reason instanceof Error ? reason.message : "Action cancelled",
                "AbortError",
              ),
          );
        };
      });
      context.signal.addEventListener("abort", cancel, { once: true });

      try {
        if (context.signal.aborted) cancel();

        const timeoutMs = typeof timeout === "number" && timeout > 0
          ? timeout * 1000
          : undefined;
        const timeoutPromise = typeof timeoutMs === "number"
          ? new Promise<never>((_, reject) => {
            const id = setTimeout(() => {
              killChild("SIGTERM");
              setTimeout(() => killChild("SIGKILL"), 500);
              reject(new Error(`Command timeout after ${timeout} seconds`));
            }, timeoutMs);
            // Ensure we clear if the process ends first
            child.status.finally(() => clearTimeout(id)).catch(() =>
              clearTimeout(id)
            );
          })
          : null;

        const statusPromise = child.status;
        const stdoutPromise = child.stdout
          ? new Response(child.stdout).arrayBuffer().then((b) =>
            new Uint8Array(b)
          )
          : Promise.resolve(new Uint8Array());
        const stderrPromise = child.stderr
          ? new Response(child.stderr).arrayBuffer().then((b) =>
            new Uint8Array(b)
          )
          : Promise.resolve(new Uint8Array());

        const execution = Promise.all([
          statusPromise,
          stdoutPromise,
          stderrPromise,
        ]);
        const result = (await Promise.race([
          execution,
          cancellationPromise,
          ...(timeoutPromise ? [timeoutPromise] : []),
        ])) as unknown as [
          { code: number; success: boolean },
          Uint8Array,
          Uint8Array,
        ];

        const status = result[0];
        const stdout = new TextDecoder().decode(result[1]);
        const stderr = new TextDecoder().decode(result[2]);

        return {
          command,
          args,
          cwd,
          stdout,
          stderr,
          exitCode: status.code,
          success: status.success,
        };
      } finally {
        context.signal.removeEventListener("abort", cancel);
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      if ((error as Error).message.includes("timeout")) {
        throw error; // Re-throw timeout errors as-is
      }
      throw new Error(`Command execution failed: ${(error as Error).message}`);
    }
  },
});
