import { definePlugin as defineFixturePlugin } from "@copilotz/copilotz/plugins";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";

import { createPluginRegistry } from "@copilotz/copilotz/plugins";
import {
  defineInlineSkill,
  defineSkill,
  parseSkillMarkdown,
  readSkillFileText,
  SKILL_TOOL_IDS,
  skillsPlugin,
} from "./index.ts";
import { skillsCatalog } from "./resources/promptContext/skillsCatalog/index.ts";
import { readSkillResourceTool } from "./resources/tools/read-skill-resource/index.ts";

function catalogContext(
  skills: Readonly<Record<string, unknown>>,
  granted: readonly string[],
) {
  const agent = {
    id: "catalog-agent",
    capabilities: { skills: [...granted] },
  };
  const resolver = {
    resolve(input: { agent: string }, context: { resources: any }) {
      const candidate = context.resources.agents?.[input.agent];
      if (!candidate) {
        throw new Error(`Unknown agent context '${input.agent}'.`);
      }
      return {
        skills: (candidate.capabilities?.skills ?? []).map((name: string) => ({
          id: name,
          resource: context.resources.skills?.[name],
        })).filter((entry: { resource?: unknown }) => entry.resource),
      };
    },
  };
  return {
    resources: {
      agents: { [agent.id]: agent },
      skills,
      capabilities: { default: resolver },
    },
    actions: {},
  };
}

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

Deno.test("Skills catalog contributes only the granted metadata before a read", async () => {
  let reads = 0;
  const granted = defineSkill({
    manifest: parseSkillMarkdown(markdown).manifest,
    files: [{
      path: "SKILL.md",
      mediaType: "text/markdown;charset=utf-8",
    }, {
      path: "references/guide.md",
      mediaType: "text/markdown;charset=utf-8",
    }],
    read() {
      reads += 1;
      return markdown;
    },
  });
  const hidden = defineInlineSkill({
    markdown: markdown.replaceAll("portable-skill", "hidden-skill"),
    directoryName: "hidden-skill",
  });
  const contribution = await skillsCatalog.contribute({
    agent: {
      id: "catalog-agent",
      capabilities: { skills: [granted.name] },
    },
    context: {
      ...catalogContext({ [granted.name]: granted, [hidden.name]: hidden }, [
        granted.name,
      ]),
    },
  } as never);

  if (!contribution || Array.isArray(contribution)) {
    throw new Error("Skills catalog did not return one contribution.");
  }
  const content = (contribution as { content: string }).content;
  assertEquals(reads, 0);
  assertStringIncludes(content, granted.name);
  assertStringIncludes(content, "load_skill");
  assertStringIncludes(content, "references/guide.md");
  assertEquals(content.includes(hidden.name), false);

  const absent = await skillsCatalog.contribute({
    agent: { id: "catalog-agent", capabilities: { skills: [] } },
    context: {
      ...catalogContext({ [granted.name]: granted }, []),
    },
  } as never);
  assertEquals(absent, null);

  const restricted = await skillsCatalog.contribute({
    agent: {
      id: "catalog-agent",
      capabilities: { skills: [granted.name] },
    },
    context: {
      resources: {
        agents: {
          "catalog-agent": {
            id: "catalog-agent",
            capabilities: { skills: [granted.name] },
          },
        },
        skills: { [granted.name]: granted },
        // Represents a final application-root policy that intentionally
        // selects no Skills despite the Agent's declaration.
        capabilities: { default: { resolve: () => ({ skills: [] }) } },
      },
      actions: {},
    },
  } as never);
  assertEquals(restricted, null);

  const widened = await skillsCatalog.contribute({
    agent: {
      id: "catalog-agent",
      capabilities: { skills: [granted.name] },
    },
    context: {
      resources: {
        agents: {
          "catalog-agent": {
            id: "catalog-agent",
            capabilities: { skills: [granted.name] },
          },
        },
        skills: { [granted.name]: granted, [hidden.name]: hidden },
        // A composed policy must still be intersected with explicit grants.
        capabilities: {
          default: {
            resolve: () => ({
              skills: [
                { id: granted.name, resource: granted },
                { id: hidden.name, resource: hidden },
              ],
            }),
          },
        },
      },
      actions: {},
    },
  } as never);
  if (!widened || Array.isArray(widened)) {
    throw new Error("Intersected catalog did not return one contribution.");
  }
  const widenedContent = (widened as { content: string }).content;
  assertStringIncludes(widenedContent, granted.name);
  assertEquals(widenedContent.includes(hidden.name), false);

  const external = defineSkill({
    manifest: {
      name: "external-catalog",
      description: "Catalogs an application-hosted external Skill.",
    },
    files: [{ path: "SKILL.md", mediaType: "text/markdown;charset=utf-8" }],
    locator: "https://example.test/skills/external-catalog/SKILL.md",
    read: () => "external content",
  });
  const externalContribution = await skillsCatalog.contribute({
    agent: { id: "catalog-agent", capabilities: { skills: [external.name] } },
    context: {
      ...catalogContext({ [external.name]: external }, [external.name]),
    },
  } as never);
  if (!externalContribution || Array.isArray(externalContribution)) {
    throw new Error("External Skill did not return one catalog contribution.");
  }
  const externalContent = (externalContribution as { content: string }).content;
  assertStringIncludes(externalContent, external.locator!);
  assertEquals(externalContent.includes("load_skill"), false);

  const unknownRead = await assertRejects(
    async () =>
      await readSkillResourceTool.action.execute({
        skill: granted.name,
        path: "references/guide.md",
      }, {
        ...catalogContext({ [granted.name]: granted }, [granted.name]),
        action: { metadata: { agentId: "missing-agent" } },
        signal: new AbortController().signal,
      } as never),
    Error,
    "not available",
  );
  assert(unknownRead instanceof Error);
  await assertRejects(
    async () =>
      await readSkillResourceTool.action.execute({
        skill: granted.name,
        path: "references/guide.md",
      }, {
        ...catalogContext({ [granted.name]: granted }, [granted.name]),
        action: { metadata: { agentId: "" } },
        signal: new AbortController().signal,
      } as never),
    Error,
    "not available",
  );

  assertThrows(
    () =>
      defineSkill({
        manifest: {
          name: external.name,
          description: external.description,
        },
        files: external.files,
        locator: "skills/external-catalog",
        read: () => "external content",
      }),
    TypeError,
    "absolute",
  );
});

Deno.test("Skills text reader rejects binary assets without changing their bytes", async () => {
  const binary = defineSkill({
    manifest: parseSkillMarkdown(markdown).manifest,
    files: [{
      path: "SKILL.md",
      mediaType: "text/markdown;charset=utf-8",
    }, {
      path: "assets/icon.png",
      mediaType: "image/png",
      size: 3,
    }],
    read(path) {
      return path === "SKILL.md" ? markdown : new Uint8Array([0, 255, 1]);
    },
  });
  await assertRejects(
    async () =>
      await readSkillResourceTool.action.execute({
        skill: binary.name,
        path: "assets/icon.png",
      }, {
        resources: { skills: { binary } },
        // No agent metadata means this is a direct host API read. Agent-bound
        // reads use the final composed capability policy instead.
        action: { metadata: {} },
        signal: new AbortController().signal,
      } as never),
    TypeError,
    "binary",
  );
  assertEquals(
    (await binary.read("assets/icon.png")).body,
    new Uint8Array([0, 255, 1]),
  );
});

Deno.test("Skills text reader accepts packaged JavaScript, XML, and SVG text", async () => {
  const skill = defineSkill({
    manifest: {
      name: "text-assets",
      description:
        "Reads textual packaged assets without decoding binary data.",
    },
    files: [
      { path: "SKILL.md", mediaType: "text/markdown;charset=utf-8" },
      { path: "scripts/check.js", mediaType: "text/javascript;charset=utf-8" },
      { path: "references/schema.xml", mediaType: "application/xml" },
      { path: "references/data.jsonld", mediaType: "application/ld+json" },
      { path: "references/page.xhtml", mediaType: "application/xhtml+xml" },
      { path: "assets/icon.svg", mediaType: "image/svg+xml" },
    ],
    read(path) {
      return {
        "SKILL.md": markdown,
        "scripts/check.js": "export const ok = true;",
        "references/schema.xml": "<schema />",
        "references/data.jsonld": '{"@id":"item"}',
        "references/page.xhtml": "<html />",
        "assets/icon.svg": "<svg />",
      }[path] ?? "";
    },
  });
  const base = {
    resources: { skills: { [skill.name]: skill } },
    action: { metadata: {} },
    signal: new AbortController().signal,
  };
  for (
    const [path, expected] of [
      ["scripts/check.js", "export const ok = true;"],
      ["references/schema.xml", "<schema />"],
      ["references/data.jsonld", '{"@id":"item"}'],
      ["references/page.xhtml", "<html />"],
      ["assets/icon.svg", "<svg />"],
    ] as const
  ) {
    const result = await readSkillResourceTool.action.execute({
      skill: skill.name,
      path,
    }, base as never) as { content: string };
    assertEquals(result.content, expected);
  }
});

Deno.test("bounded Skill text reads stop when cancellation arrives mid-stream", async () => {
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode("first chunk"));
      queueMicrotask(() => controller.abort(new Error("read cancelled")));
    },
  });
  await assertRejects(
    () =>
      readSkillFileText(
        {
          path: "references/stream.txt",
          mediaType: "text/plain;charset=utf-8",
          body: stream,
        },
        1_000,
        controller.signal,
      ),
    Error,
    "read cancelled",
  );
});

Deno.test("bounded Skill text reads cancel a stalled reader promptly", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
      return new Promise<void>(() => undefined);
    },
  });
  const pending = readSkillFileText(
    {
      path: "references/stalled.txt",
      mediaType: "text/plain;charset=utf-8",
      body: stream,
    },
    1_000,
    controller.signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new Error("stalled read cancelled"));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      assertRejects(() => pending, Error, "stalled read cancelled"),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("stalled read did not abort")),
          1_000,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  assert(cancelled, "external cancellation must cancel the stream reader");
  assert(!stream.locked, "cancelled reads must release the stream lock");
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
  const base = defineFixturePlugin({
    ...skillsPlugin,
    id: "@acme/base-skills",
    version: "1.0.0",
    actions: {},
    resources: {
      tools: {},
      skills: Object.fromEntries([first].map((skill) => [skill.name, skill])),
      skillConfig: { default: { maximumTextBytes: undefined } },
    },
  });
  const overriding = defineFixturePlugin({
    ...skillsPlugin,
    id: "@acme/overriding-skills",
    version: "1.0.0",
    resources: {
      ...skillsPlugin.resources,
      skills: Object.fromEntries(
        [replacement].map((skill) => [skill.name, skill]),
      ),
      skillConfig: { default: { maximumTextBytes: undefined } },
    },
  });
  assertEquals(Object.keys(base.resources.tools ?? {}), []);
  assertEquals(Object.keys(base.actions), []);
  assertEquals(Object.keys(overriding.resources.tools ?? {}), [
    ...SKILL_TOOL_IDS,
  ]);
  assertEquals(Object.keys(overriding.actions), [...SKILL_TOOL_IDS]);
  for (const alias of SKILL_TOOL_IDS) {
    assertEquals(
      (overriding.resources.tools?.[alias] as { action?: string }).action,
      alias,
    );
    assert(overriding.actions[alias]);
  }

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
    ["ask", "readToolResult", ...SKILL_TOOL_IDS],
  );
  for (const alias of SKILL_TOOL_IDS) assert(registry.actions[alias]);
});

Deno.test("skill core remains factory-first and runtime-neutral", async () => {
  for (
    const module of [
      "shared/parser.ts",
      "plugin.ts",
      "resources/skill/index.ts",
      "authoring/action-resources/index.ts",
    ]
  ) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bDeno\b|\bBun\b|\bprocess\b/.test(source));
    assert(!/from\s+["']node:/.test(source));
    assert(!/^\s*(?:export\s+)?class\s/m.test(source));
    assert(!/resources\/skills|data:text|sourcePath/.test(source));
  }
});
