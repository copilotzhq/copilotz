export function createFileLogger(path: string = "mcp-client.log"): (...args: unknown[]) => void {

    // override console.log with our log function avoid 
    // interference with mcp server std transport
    Object.keys(globalThis.console).forEach((key: string) => {
        // best-effort redirection; ignore type incompatibilities
        (globalThis.console as unknown as Record<string, unknown>)[key] = log as unknown as never;
    });

    function log(...args: unknown[]) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${args.map((v) => String(v)).join(" ")}\n`;
        const anyGlobal = globalThis as unknown as { Deno?: { writeTextFileSync?: (p: string, data: string, opts?: { append?: boolean }) => void } };
        if (anyGlobal?.Deno?.writeTextFileSync) {
            anyGlobal.Deno.writeTextFileSync(path, logMessage, { append: true });
        } else {
            // Fallback when Deno is not available
            (globalThis as unknown as { console?: Console }).console?.log?.(logMessage);
        }
    }

    return log;
}