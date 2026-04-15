import type { ToolExecutionContext } from "@/resources/processors/tool_call/index.ts";
import { filterSkillsForAgent } from "@/runtime/loaders/skill-loader.ts";

interface LoadSkillParams {
    name: string;
}

export default {
    key: "load_skill",
    name: "Load Skill",
    description:
        "Load the full instructions of a specific skill by name. Use list_skills first to see available skills.",
    inputSchema: {
        type: "object",
        properties: {
            name: {
                type: "string",
                description: "Name of the skill to load.",
                minLength: 1,
            },
        },
        required: ["name"],
    },
    execute: async ({ name }: LoadSkillParams, context?: ToolExecutionContext) => {
        const skills = context?.skills ?? [];
        const agent = context?.senderId
            ? context.agents?.find(
                  (a) => a.id === context.senderId || a.name === context.senderId,
              )
            : undefined;
        const filtered = filterSkillsForAgent(skills, agent);
        const skill = filtered.find((s) => s.name === name);
        if (!skill) {
            throw new Error(
                `Skill "${name}" not found. Use list_skills to see available skills.`,
            );
        }
        return {
            name: skill.name,
            description: skill.description,
            content: skill.content,
            allowedTools: skill.allowedTools,
            hasReferences: skill.hasReferences,
        };
    },
};
