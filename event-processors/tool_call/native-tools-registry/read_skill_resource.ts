import type { ToolExecutionContext } from "../index.ts";
import { filterSkillsForAgent } from "@/utils/loaders/skill-loader.ts";

interface ReadSkillResourceParams {
    skill: string;
    path: string;
}

export default {
    key: "read_skill_resource",
    name: "Read Skill Resource",
    description:
        "Read a supporting file from a skill's references/ directory. Only works for local skills (not remote).",
    inputSchema: {
        type: "object",
        properties: {
            skill: {
                type: "string",
                description: "Name of the skill.",
                minLength: 1,
            },
            path: {
                type: "string",
                description:
                    "Relative path within the skill's references/ directory.",
                minLength: 1,
            },
        },
        required: ["skill", "path"],
    },
    execute: async (
        { skill: skillName, path: filePath }: ReadSkillResourceParams,
        context?: ToolExecutionContext,
    ) => {
        const skills = context?.skills ?? [];
        const agent = context?.senderId
            ? context.agents?.find(
                  (a) => a.id === context.senderId || a.name === context.senderId,
              )
            : undefined;
        const filtered = filterSkillsForAgent(skills, agent);
        const skill = filtered.find((s) => s.name === skillName);

        if (!skill) {
            throw new Error(
                `Skill "${skillName}" not found. Use list_skills to see available skills.`,
            );
        }
        if (!skill.hasReferences) {
            throw new Error(`Skill "${skillName}" has no references/ directory.`);
        }
        if (skill.source === "remote") {
            throw new Error(
                "Cannot read resources from remote skills. Reference content must be included inline in the SKILL.md body for remote skills.",
            );
        }

        // Path traversal prevention
        const normalized = filePath.replace(/\.\.\//g, "").replace(/\.\./g, "");
        const fullPath = skill.sourcePath + "/references/" + normalized;

        try {
            const content = await Deno.readTextFile(fullPath);
            return { skill: skillName, path: filePath, content };
        } catch {
            throw new Error(
                `File "${filePath}" not found in skill "${skillName}" references.`,
            );
        }
    },
};
