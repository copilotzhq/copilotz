import type { ToolExecutionContext } from "@/resources/processors/tool_call/index.ts";
import { filterSkillsForAgent } from "@/runtime/loaders/skill-loader.ts";

export default {
    key: "list_skills",
    name: "List Skills",
    description:
        "List all available skills with their names and descriptions. Skills provide step-by-step instructions for specific tasks. Use load_skill to read the full content of a skill before executing it.",
    inputSchema: {
        type: "object",
        properties: {},
    },
    execute: async (_params: unknown, context?: ToolExecutionContext) => {
        const skills = context?.skills ?? [];
        const agent = context?.senderId
            ? context.agents?.find(
                  (a) => a.id === context.senderId || a.name === context.senderId,
              )
            : undefined;
        const filtered = filterSkillsForAgent(skills, agent);
        return {
            skills: filtered.map((s) => ({
                name: s.name,
                description: s.description,
                tags: s.tags,
                hasReferences: s.hasReferences,
            })),
            count: filtered.length,
        };
    },
};
