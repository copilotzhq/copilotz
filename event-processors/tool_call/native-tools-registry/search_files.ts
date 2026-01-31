interface SearchFilesParams {
    directory?: string;
    pattern: string;
    recursive?: boolean;
    includeHidden?: boolean;
}

interface FileResult {
    name: string;
    path: string;
    type: "file";
}

export default {
    key: "search_files",
    name: "Search Files",
    description: "Search for files by name pattern in a directory.",
    inputSchema: {
        type: "object",
        properties: {
            directory: {
                type: "string",
                description: "Directory to search in.",
                default: "."
            },
            pattern: {
                type: "string",
                description: "File name pattern to search for (supports * wildcards)."
            },
            recursive: {
                type: "boolean",
                description: "Search subdirectories recursively.",
                default: false
            },
            includeHidden: {
                type: "boolean",
                description: "Include hidden files (starting with .).",
                default: false
            },
        },
        required: ["pattern"],
    },
    execute: async ({ directory = ".", pattern, recursive = false, includeHidden = false }: SearchFilesParams) => {
        try {
            // Security check
            if (directory.includes("..") || directory.includes("~")) {
                throw new Error("Directory traversal not allowed");
            }
            
            const results: FileResult[] = [];
            
            // Convert pattern to regex (simple implementation)
            const regexPattern = pattern
                .replace(/\./g, "\\.")
                .replace(/\*/g, ".*")
                .replace(/\?/g, ".");
            const regex = new RegExp(`^${regexPattern}$`, "i");
            
            const searchDir = async (dir: string, depth = 0): Promise<void> => {
                if (depth > 10) return; // Prevent infinite recursion
                
                try {
                    const denoNs = (globalThis as unknown as { Deno?: { readDir?: (p: string) => AsyncIterable<{ name: string; isFile: boolean; isDirectory: boolean }> } }).Deno;
                    if (!denoNs?.readDir) throw new Error("search_files tool requires Deno runtime");
                    for await (const entry of denoNs.readDir(dir)) {
                        // Skip hidden files unless requested
                        if (!includeHidden && entry.name.startsWith(".")) {
                            continue;
                        }
                        
                        const fullPath = `${dir}/${entry.name}`.replace(/\/+/g, "/");
                        
                        if (entry.isFile && regex.test(entry.name)) {
                            results.push({
                                name: entry.name,
                                path: fullPath,
                                type: "file"
                            });
                        } else if (entry.isDirectory && recursive) {
                            await searchDir(fullPath, depth + 1);
                        }
                    }
                } catch (_error) {
                    // Skip directories we can't access
                    console.warn(`Cannot access directory: ${dir}`);
                }
            };
            
            await searchDir(directory);
            
            return {
                directory,
                pattern,
                recursive,
                results,
                count: results.length
            };
        } catch (error) {
            throw new Error(`File search failed: ${(error as Error).message}`);
        }
    },
}