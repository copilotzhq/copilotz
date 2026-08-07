import { assert, assertEquals, assertThrows } from "@std/assert";

import { createPluginRegistry } from "../plugins/index.ts";
import {
  BUNDLED_SKILL_IDS,
  createBundledSkillsPlugin,
  getBundledSkills,
} from "./plugin.ts";
import { parseSkillMarkdown } from "./parser.ts";

Deno.test("bundled skills are immutable plugin resources with stable IDs", async () => {
  const plugin = createBundledSkillsPlugin();
  assertEquals(plugin.manifest.provides.skills, [...BUNDLED_SKILL_IDS]);
  assertEquals(
    plugin.resources.skills?.map((value) => (value as { name: string }).name),
    [...BUNDLED_SKILL_IDS],
  );
  assert(getBundledSkills().every((skill) => Object.isFrozen(skill)));
  const registry = await createPluginRegistry({ core: plugin });
  assertEquals(registry.list("skills").length, BUNDLED_SKILL_IDS.length);
  assertEquals(
    (registry.require("skills", "create-agent") as { source: string }).source,
    "bundled",
  );
});

Deno.test("bundled skills can be selected without changing catalog order", () => {
  const plugin = createBundledSkillsPlugin({
    include: ["configure-mcp", "create-agent"],
  });
  assertEquals(plugin.manifest.provides.skills, [
    "configure-mcp",
    "create-agent",
  ]);
  assertThrows(
    () =>
      createBundledSkillsPlugin({
        include: ["create-agent", "create-agent"],
      }),
    TypeError,
    "duplicate IDs",
  );
  assertThrows(
    () =>
      createBundledSkillsPlugin({
        include: ["missing" as "create-agent"],
      }),
    TypeError,
    "Unknown bundled skill",
  );
});

Deno.test("bundled skill plugin performs no filesystem or network I/O", async () => {
  const source = await Deno.readTextFile(new URL("plugin.ts", import.meta.url));
  assert(!/\bDeno\./.test(source));
  assert(!/\bfetch\s*\(/.test(source));
  assert(!/from\s+["']node:/.test(source));
  assert(!/^\s*(?:export\s+)?class\s/m.test(source));
});

Deno.test("skill frontmatter parsing is permissionless and supports multiline lists", () => {
  const parsed = parseSkillMarkdown(`---
name: portable-skill
allowed-tools: [
  read_file,
  write_file,
]
enabled: true
---
# Portable
`);

  assertEquals(parsed.frontmatter, {
    name: "portable-skill",
    "allowed-tools": ["read_file", "write_file"],
    enabled: true,
  });
  assertEquals(parsed.body, "# Portable");
});
