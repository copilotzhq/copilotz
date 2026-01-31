interface WriteFileParams {
    path: string;
    content: string;
    encoding?: string;
    createDirs?: boolean;
}

export default {
    key: "write_file",
    name: "Write File",
    description: "Write content to a file on the local filesystem.",
    inputSchema: {
        type: "object",
        properties: {
            path: { type: "string", description: "Path to the file to write." },
            content: { type: "string", description: "Content to write to the file." },
            encoding: { 
                type: "string", 
                description: "Text encoding (always utf8 for text files).",
                default: "utf8"
            },
            createDirs: {
                type: "boolean",
                description: "Create parent directories if they don't exist.",
                default: false
            },
        },
        required: ["path", "content"],
    },
    execute: async ({ path, content, encoding: _encoding = "utf8", createDirs = false }: WriteFileParams) => {
        try {
            // Security check - prevent directory traversal
            if (path.includes("..") || path.includes("~")) {
                throw new Error("Directory traversal not allowed");
            }
            
            // Create parent directories if requested
            if (createDirs) {
                const dir = path.substring(0, path.lastIndexOf("/"));
                if (dir) {
                    const denoNs = (globalThis as unknown as { Deno?: { mkdir?: (p: string, opts?: { recursive?: boolean }) => Promise<void>; errors?: { NotFound?: unknown; PermissionDenied?: unknown } } }).Deno;
                    if (!denoNs?.mkdir) {
                        throw new Error("write_file tool requires Deno runtime");
                    }
                    await denoNs.mkdir(dir, { recursive: true });
                }
            }
            
            // Write file content (Deno.writeTextFile always uses UTF-8)
            {
                const denoNs = (globalThis as unknown as { Deno?: { writeTextFile?: (p: string, data: string) => Promise<void> } }).Deno;
                if (!denoNs?.writeTextFile) {
                    throw new Error("write_file tool requires Deno runtime");
                }
                await denoNs.writeTextFile(path, content);
            }
            
            return {
                path,
                size: content.length,
                encoding: "utf8",
                created: createDirs
            };
        } catch (error) {
            const denoErrors = (globalThis as unknown as { Deno?: { errors?: { NotFound?: unknown; PermissionDenied?: unknown } } }).Deno?.errors;
            if (denoErrors?.NotFound && error instanceof (denoErrors.NotFound as { new (...args: unknown[]): unknown })) {
                throw new Error(`Directory not found: ${path}`);
            } else if (denoErrors?.PermissionDenied && error instanceof (denoErrors.PermissionDenied as { new (...args: unknown[]): unknown })) {
                throw new Error(`Permission denied: ${path}`);
            }
            throw new Error(`Failed to write file: ${(error as Error).message}`);
        }
    },
}