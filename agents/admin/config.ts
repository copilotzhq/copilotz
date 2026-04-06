import type { Agent } from "@/interfaces/index.ts";

export default {
    role: "Framework Development Assistant",
    description: "Helps build and configure Copilotz agents, tools, APIs, and other resources.",
    allowedTools: [
        "list_skills",
        "load_skill",
        "read_skill_resource",
        "read_file",
        "write_file",
        "list_directory",
        "search_files",
        "search_code",
        "apply_patch",
        "show_file_diff",
        "restore_file_version",
    ],
} as Partial<Agent>;
