import { mapSkills, skillManifest } from "../../../shared/snapshots.ts";
/** Contributes the authorized Skills catalog without loading any Skill bodies. @module */

import {
  type ContextContributionInput,
  type ContextResource,
  defineContextResource,
} from "@copilotz/copilotz/core";
import type { RuntimeContextNamespaces } from "@copilotz/copilotz/actions";
import type { Skill } from "../../../shared/contracts.ts";

async function catalogEntry(
  skill: Skill,
  scope: object,
  signal?: AbortSignal,
): Promise<string> {
  const manifest = await skillManifest(skill, { scope, signal });
  const resources = skill.files.filter((file) => file.path !== "SKILL.md");
  return [
    `- **${skill.name}**: ${manifest.description}`,
    skill.locator
      ? `  Retrieval locator: \`${skill.locator}\` (authorized file/HTTP route).`
      : "  Retrieval route: Skill reader (`load_skill`).",
    resources.length
      ? skill.locator
        ? `  Supporting paths relative to that location: ${
          resources.map((file) => file.path).join(", ")
        }`
        : `  Supporting files (read with \`read_skill_resource\`): ${
          resources.map((file) => file.path).join(", ")
        }`
      : "",
    ...(skill.dynamicFiles
      ? [
        "  Supporting files referenced in the instructions can be read with `read_skill_resource`.",
      ]
      : []),
  ].filter(Boolean).join("\n");
}

/** Skills-owned, lazy catalog shown before the first reader-tool call. */
export const skillsCatalog: ContextResource = defineContextResource({
  id: "copilotz.skills.catalog",
  type: "context",
  purposes: ["conversation"],
  async contribute(input: ContextContributionInput) {
    const resolver = (input.context.resources as unknown as {
      capabilities?: Readonly<
        Record<
          string,
          {
            resolve(
              input: Readonly<{ agent: string }>,
              context: Readonly<{
                resources: RuntimeContextNamespaces;
                actions: Readonly<Record<string, unknown>>;
              }>,
            ): Readonly<{
              skills: readonly Readonly<{ id: string; resource: Skill }>[];
            }>;
          } | undefined
        >
      >;
    }).capabilities?.default;
    if (!resolver) return null;
    let granted: readonly Skill[];
    try {
      const resolved = resolver.resolve(
        { agent: input.agent.id },
        {
          resources: input.context
            .resources as unknown as RuntimeContextNamespaces,
          actions: input.context.actions,
        },
      );
      const explicit = new Set(input.agent.capabilities?.skills ?? []);
      granted = resolved.skills.filter(({ id }) => explicit.has(id)).map(({
        resource,
      }) => resource);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Unknown agent context")
      ) {
        return null;
      }
      throw error;
    }
    if (!granted.length) return null;
    return {
      id: "catalog",
      title: "Available Skills",
      role: "context",
      content: (await mapSkills(granted, (skill) =>
        catalogEntry(skill, input.context.resources, input.context.signal)))
        .join("\n"),
    } as const;
  },
});

export default skillsCatalog;
