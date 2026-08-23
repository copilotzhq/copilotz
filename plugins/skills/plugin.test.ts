import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";

import { createPluginRegistry } from "@copilotz/copilotz/plugins";
import {
  createSkillsPlugin,
  defineInlineSkill,
  defineSkill,
  parseSkillMarkdown,
  SKILL_TOOL_IDS,
} from "./index.ts";

const markdown = `---
name: portable-skill
description: Handles portable skill tests when validating runtime behavior.
license: Apache-2.0
compatibility: Works in Web API runtimes.
metadata:
  author: acme
  version: "1.0"
allowed-tools: Read Bash(git:*)
---
# Portable

Follow the portable instructions.
`;

Deno.test("Agent Skills frontmatter uses strict YAML and specification validation", () => {
  const parsed = parseSkillMarkdown(markdown, {
    directoryName: "portable-skill",
  });
  assertEquals(parsed.manifest, {
    name: "portable-skill",
    description:
      "Handles portable skill tests when validating runtime behavior.",
    license: "Apache-2.0",
    compatibility: "Works in Web API runtimes.",
    metadata: { author: "acme", version: "1.0" },
    allowedTools: "Read Bash(git:*)",
  });
  assertEquals(parsed.body, "# Portable\n\nFollow the portable instructions.");

  assertThrows(
    () => parseSkillMarkdown("# Missing frontmatter"),
    TypeError,
    "must begin",
  );
  assertThrows(
    () => parseSkillMarkdown(markdown, { directoryName: "different-skill" }),
    TypeError,
    "must match directory",
  );
  assertThrows(
    () =>
      parseSkillMarkdown(`---
name: invalid--name
description: Invalid.
---`),
    TypeError,
    "single hyphens",
  );
  assertThrows(
    () =>
      parseSkillMarkdown(`---
name: invalid-tools
description: Invalid.
allowed-tools: [Read, Write]
---`),
    TypeError,
    "allowed-tools",
  );
  assertThrows(
    () =>
      parseSkillMarkdown(`---
name: invalid-extension
description: Invalid.
tags: [test]
---`),
    TypeError,
    "Use metadata",
  );
});

Deno.test("skill resources expose eager metadata and lazy bounded file reads", async () => {
  let reads = 0;
  const skill = defineSkill({
    manifest: parseSkillMarkdown(markdown).manifest,
    files: [{
      path: "SKILL.md",
      mediaType: "text/markdown;charset=utf-8",
    }, {
      path: "references/guide.md",
      mediaType: "text/markdown;charset=utf-8",
    }],
    read(path) {
      reads += 1;
      return path === "SKILL.md" ? markdown : "# Guide";
    },
  });
  assertEquals(skill.name, "portable-skill");
  assertEquals(reads, 0);
  assert(Object.isFrozen(skill));
  assert(Object.isFrozen(skill.files));
  assertEquals((await skill.read("references/guide.md")).body, "# Guide");
  assertEquals(reads, 1);
  const controller = new AbortController();
  controller.abort(new Error("skill read cancelled"));
  await assertRejects(
    () => skill.read("SKILL.md", { signal: controller.signal }),
    Error,
    "skill read cancelled",
  );
  assertEquals(reads, 1);
  await assertRejects(
    () => skill.read("../secret"),
    TypeError,
    "inside the skill root",
  );
  await assertRejects(
    () => skill.read("assets/missing.png"),
    Error,
    "does not provide",
  );
});

Deno.test("skills plugins own disclosure tools and preserve stable-ID overrides", async () => {
  const first = defineInlineSkill({
    markdown,
    directoryName: "portable-skill",
  });
  const replacement = defineInlineSkill({
    markdown: markdown.replace(
      "Handles portable skill tests when validating runtime behavior.",
      "Replacement instructions for portable runtime behavior.",
    ),
    directoryName: "portable-skill",
    files: { "references/guide.md": "# Replacement guide" },
  });
  const base = createSkillsPlugin({
    id: "@acme/base-skills",
    version: "1.0.0",
    skills: [first],
  });
  const overriding = createSkillsPlugin({
    id: "@acme/overriding-skills",
    version: "1.0.0",
    skills: [replacement],
  });
  assertEquals(Object.keys(base.resources.tools ?? {}), [
    "list_skills",
    "load_skill",
  ]);
  assertEquals(Object.keys(overriding.resources.tools ?? {}), [
    ...SKILL_TOOL_IDS,
  ]);

  const registry = await createPluginRegistry({
    plugins: [base, overriding],
  });
  assertEquals(
    (registry.resources.skills["portable-skill"] as { description: string })
      .description,
    "Replacement instructions for portable runtime behavior.",
  );
  assertEquals(
    Object.keys(registry.resources.tools),
    [...SKILL_TOOL_IDS],
  );
});

Deno.test("skill core remains factory-first and runtime-neutral", async () => {
  for (const module of ["parser.ts", "plugin.ts", "skill.ts", "tools.ts"]) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bDeno\b|\bBun\b|\bprocess\b/.test(source));
    assert(!/from\s+["']node:/.test(source));
    assert(!/^\s*(?:export\s+)?class\s/m.test(source));
    assert(!/resources\/skills|data:text|sourcePath/.test(source));
  }
});
