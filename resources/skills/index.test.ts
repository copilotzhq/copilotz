import { assert, assertEquals } from "@std/assert";
import { basename, fromFileUrl, join } from "@std/path";

import manifest from "@/resources/manifest.ts";
import { loadBundledSkills } from "@/resources/skills/index.ts";

const RESOURCE_SKILL_COVERAGE = new Map<string, string>([
  ["agents", "create-agent"],
  ["tools", "create-tool"],
  ["features", "create-feature"],
  ["collections", "setup-collection"],
  ["processors", "add-processor"],
  ["channels", "create-channel"],
  ["llm", "create-llm-provider"],
  ["memory", "create-memory"],
  ["embeddings", "create-embedding-provider"],
  ["storage", "create-storage-adapter"],
  ["apis", "add-api-integration"],
  ["mcp servers", "configure-mcp"],
]);

Deno.test("bundled skills are registered consistently across directories, index, and manifest", async () => {
  const skillsDir = fromFileUrl(new URL(".", import.meta.url));
  const diskSkillDirs: string[] = [];

  for await (const entry of Deno.readDir(skillsDir)) {
    if (!entry.isDirectory || entry.name.startsWith(".")) continue;
    const skillMd = join(skillsDir, entry.name, "SKILL.md");
    try {
      const stat = await Deno.stat(skillMd);
      if (stat.isFile) diskSkillDirs.push(entry.name);
    } catch {
      // skip directories without SKILL.md
    }
  }

  const diskNames = diskSkillDirs.sort();
  const manifestNames = [...(manifest.provides.skills ?? [])].sort();
  const loadedNames = (await loadBundledSkills()).map((skill) => skill.name)
    .sort();

  assertEquals(loadedNames, diskNames);
  assertEquals(manifestNames, diskNames);
});

Deno.test("bundled skill catalog covers every first-class documented resource type", async () => {
  const resourceTypesPath = fromFileUrl(
    new URL("../../docs/resources/resource-types.md", import.meta.url),
  );
  const resourceTypes = await Deno.readTextFile(resourceTypesPath);
  const documentedResourceTypes = Array.from(
    resourceTypes.matchAll(/^\|\s*([^|]+?)\s*\|/gm),
    (match) => match[1].trim().toLowerCase(),
  )
    .filter((resource) =>
      resource !== "resource" &&
      !resource.startsWith("---") &&
      resource !== "skills"
    )
    .sort();

  const mappedResourceTypes = [...RESOURCE_SKILL_COVERAGE.keys()].sort();
  assertEquals(mappedResourceTypes, documentedResourceTypes);

  const bundledSkillNames = new Set(
    (await loadBundledSkills()).map((skill) => skill.name),
  );

  for (const [page, skill] of RESOURCE_SKILL_COVERAGE) {
    assert(
      bundledSkillNames.has(skill),
      `Expected resource type ${
        basename(page)
      } to be covered by skill ${skill}.`,
    );
  }
});

Deno.test("bundled skills include both resource implementation and execution workflows", async () => {
  const bundledSkillNames = new Set(
    (await loadBundledSkills()).map((skill) => skill.name),
  );

  const expectedExecutionSkills = [
    "explore-codebase",
    "implement-feature",
    "debug-runtime-issue",
    "refactor-resource-architecture",
    "integrate-external-service",
    "build-copilotz-system",
    "review-copilotz-project",
    "ship-chat-experience",
  ];

  for (const skill of expectedExecutionSkills) {
    assert(bundledSkillNames.has(skill), `Missing execution skill ${skill}.`);
  }
});
