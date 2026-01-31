interface ReadFileParams {
    path: string;
    encoding?: string;
}

export default {
    key: "read_file",
    name: "Read File",
    description: "Read content from a file on the local filesystem.",
    inputSchema: {
        type: "object",
        properties: {
            path: { type: "string", description: "Path to the file to read." },
            encoding: { 
                type: "string", 
                description: "Text encoding (always utf8 for text files).",
                default: "utf8"
            },
        },
        required: ["path"],
    },
    execute: async ({ path, encoding: _encoding = "utf8" }: ReadFileParams) => {
        try {
            // Security check - prevent directory traversal
            if (path.includes("..") || path.includes("~")) {
                throw new Error("Directory traversal not allowed");
            }
            
            // Read file content (Deno.readTextFile always uses UTF-8)
            const denoNs = (globalThis as unknown as { Deno?: { readTextFile?: (p: string) => Promise<string>; errors?: { NotFound?: unknown; PermissionDenied?: unknown } } }).Deno;
            if (!denoNs?.readTextFile) {
                throw new Error("read_file tool requires Deno runtime");
            }
            const content = await denoNs.readTextFile(path);
            
            return {
                path,
                content,
                size: content.length,
                encoding: "utf8"
            };
        } catch (error) {
            const denoErrors = (globalThis as unknown as { Deno?: { errors?: { NotFound?: unknown; PermissionDenied?: unknown } } }).Deno?.errors;
            if (denoErrors?.NotFound && error instanceof (denoErrors.NotFound as { new (...args: unknown[]): unknown })) {
                throw new Error(`File not found: ${path}`);
            } else if (denoErrors?.PermissionDenied && error instanceof (denoErrors.PermissionDenied as { new (...args: unknown[]): unknown })) {
                throw new Error(`Permission denied: ${path}`);
            }
            throw new Error(`Failed to read file: ${(error as Error).message}`);
        }
    },
}