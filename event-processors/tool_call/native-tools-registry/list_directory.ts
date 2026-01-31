interface ListDirectoryParams {
    path: string;
    showHidden?: boolean;
}

interface DirectoryEntry {
    name: string;
    type: "file" | "directory";
    size?: number;
}

export default {
    key: "list_directory",
    name: "List Directory",
    description: "List contents of a directory.",
    inputSchema: {
        type: "object",
        properties: {
            path: { 
                type: "string", 
                description: "Path to the directory to list.",
                default: "."
            },
            showHidden: {
                type: "boolean",
                description: "Include hidden files (starting with .).",
                default: false
            },
        },
    },
    execute: async ({ path = ".", showHidden = false }: ListDirectoryParams) => {
        try {
            // Security check - prevent directory traversal
            if (path.includes("..") || path.includes("~")) {
                throw new Error("Directory traversal not allowed");
            }
            
            const entries: DirectoryEntry[] = [];
            
            const denoNs = (globalThis as unknown as { Deno?: { readDir?: (p: string) => AsyncIterable<{ name: string; isFile: boolean; isDirectory: boolean }>; stat?: (p: string) => Promise<{ size?: number }> } }).Deno;
            if (!denoNs?.readDir) {
                throw new Error("list_directory tool requires Deno runtime");
            }
            for await (const entry of denoNs.readDir(path)) {
                // Skip hidden files unless requested
                if (!showHidden && entry.name.startsWith(".")) {
                    continue;
                }
                
                const dirEntry: DirectoryEntry = {
                    name: entry.name,
                    type: entry.isFile ? "file" : "directory"
                };
                
                // Try to get file size for files
                if (entry.isFile) {
                    try {
                        if (denoNs?.stat) {
                            const stat = await denoNs.stat(`${path}/${entry.name}`);
                            dirEntry.size = stat?.size;
                        }
                    } catch {
                        // Ignore stat errors
                    }
                }
                
                entries.push(dirEntry);
            }
            
            // Sort: directories first, then files, alphabetically
            entries.sort((a, b) => {
                if (a.type !== b.type) {
                    return a.type === "directory" ? -1 : 1;
                }
                return a.name.localeCompare(b.name);
            });
            
            return {
                path,
                entries,
                count: entries.length
            };
        } catch (error) {
            const denoErrors = (globalThis as unknown as { Deno?: { errors?: { NotFound?: unknown; PermissionDenied?: unknown } } }).Deno?.errors;
            if (denoErrors?.NotFound && error instanceof (denoErrors.NotFound as { new (...args: unknown[]): unknown })) {
                throw new Error(`Directory not found: ${path}`);
            } else if (denoErrors?.PermissionDenied && error instanceof (denoErrors.PermissionDenied as { new (...args: unknown[]): unknown })) {
                throw new Error(`Permission denied: ${path}`);
            }
            throw new Error(`Failed to list directory: ${(error as Error).message}`);
        }
    },
}