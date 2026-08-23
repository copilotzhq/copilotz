import { assert, assertEquals, assertRejects } from "@std/assert";
import { join, toFileUrl } from "../../../dependencies/std-path.ts";

import {
  buildOpenSkillsPlugin,
  createProcessToolsPlugin,
  createWorkspaceToolsPlugin,
  PROCESS_TOOL_IDS,
  WORKSPACE_TOOL_IDS,
} from "./index.ts";
import * as denoAdapter from "./index.ts";

Deno.test("Deno adapter packages workspace and process tools by stable ID", () => {
  const workspace = createWorkspaceToolsPlugin();
  const process = createProcessToolsPlugin();
  const workspaceTools = workspace.resources.tools ?? {};
  const processTools = process.resources.tools ?? {};
  assertEquals(
    Object.keys(workspaceTools),
    [...WORKSPACE_TOOL_IDS],
  );
  assertEquals(Object.keys(processTools), [...PROCESS_TOOL_IDS]);
  assertEquals(workspace.id, "@copilotz/workspace-tools");
  assertEquals(process.id, "@copilotz/process-tools");
  assert(
    Object.values(workspaceTools).every((tool) => Object.isFrozen(tool)),
  );
  assertEquals(
    Object.keys(
      createWorkspaceToolsPlugin({ include: ["read_file"] }).resources
        .tools ?? {},
    ),
    ["read_file"],
  );
  for (
    const removed of [
      "createDenoProcessToolsPlugin",
      "createDenoWorkspaceToolsPlugin",
      "DENO_PROCESS_TOOL_IDS",
      "DENO_WORKSPACE_TOOL_IDS",
    ]
  ) assertEquals(removed in denoAdapter, false, removed);
});

Deno.test("Deno builds standard skill directories into a portable lazy plugin", async () => {
  const temporary = await Deno.makeTempDir({ prefix: "copilotz-skills-" });
  try {
    const root = join(temporary, "skills");
    const skillRoot = join(root, "contract-skill");
    const references = join(skillRoot, "references");
    const output = join(temporary, "generated");
    await Deno.mkdir(references, { recursive: true });
    await Deno.writeTextFile(
      join(skillRoot, "SKILL.md"),
      `---
name: contract-skill
description: Validates portable generated skill plugins.
metadata:
  version: "1.0"
---
# Contract

Follow the generated instructions.`,
    );
    await Deno.writeTextFile(
      join(references, "guide.md"),
      "# Generated guide",
    );

    const build = await buildOpenSkillsPlugin({
      root,
      output,
      id: "@acme/generated-skills",
      version: "1.0.0",
      runtimeImport: new URL("../../skills/index.ts", import.meta.url).href,
    });
    assertEquals(build.skillNames, ["contract-skill"]);
    assertEquals(build.generatedFiles.length, 2);
    const catalog = await Deno.readTextFile(build.pluginModule);
    assert(!catalog.includes("Follow the generated instructions"));

    const loaded = await import(
      `${toFileUrl(build.pluginModule).href}?test=${crypto.randomUUID()}`
    );
    assertEquals(Object.keys(loaded.default.resources.skills ?? {}), [
      "contract-skill",
    ]);
    const skill = loaded.default.resources.skills["contract-skill"];
    assertEquals(skill.name, "contract-skill");
    assertEquals(
      (await skill.read("references/guide.md")).body,
      "# Generated guide",
    );

    await assertRejects(
      () =>
        buildOpenSkillsPlugin({
          root,
          output: join(root, "generated"),
          id: "@acme/inside-source",
          version: "1.0.0",
        }),
      TypeError,
      "outside canonical skill source",
    );

    const invalid = join(root, "wrong-directory");
    await Deno.mkdir(invalid);
    await Deno.writeTextFile(
      join(invalid, "SKILL.md"),
      `---
name: different-name
description: Invalid directory identity.
---`,
    );
    await assertRejects(
      () =>
        buildOpenSkillsPlugin({
          root,
          output,
          id: "@acme/invalid",
          version: "1.0.0",
        }),
      TypeError,
      "must match directory",
    );
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
});

Deno.test("Deno-specific APIs stay outside generic adapter and core entrypoints", async () => {
  for (const module of ["../index.ts", "../../tools/index.ts"]) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/adapters\/deno/.test(source), module);
  }
  const denoSource = await Deno.readTextFile(
    new URL("skills.ts", import.meta.url),
  );
  assert(/\bDeno\.readFile/.test(denoSource));
  assert(/\bDeno\.writeTextFile/.test(denoSource));
  assert(!/createDenoSkillDirectorySource/.test(denoSource));
  assert(!/^\s*(?:export\s+)?class\s/m.test(denoSource));
});
