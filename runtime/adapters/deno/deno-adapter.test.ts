import { assert, assertEquals, assertRejects } from "@std/assert";

import {
  createDenoProcessToolsPlugin,
  createDenoSkillResourceReader,
  createDenoWorkspaceToolsPlugin,
  DENO_PROCESS_TOOL_IDS,
  DENO_WORKSPACE_TOOL_IDS,
} from "./index.ts";

Deno.test("Deno adapter packages workspace and process tools by stable ID", () => {
  const workspace = createDenoWorkspaceToolsPlugin();
  const process = createDenoProcessToolsPlugin();
  assertEquals(
    workspace.manifest.provides.tools,
    [...DENO_WORKSPACE_TOOL_IDS],
  );
  assertEquals(process.manifest.provides.tools, [...DENO_PROCESS_TOOL_IDS]);
  assert(
    workspace.resources.tools?.every((tool) => Object.isFrozen(tool)),
  );
  assertEquals(
    createDenoWorkspaceToolsPlugin({ include: ["read_file"] }).manifest
      .provides.tools,
    ["read_file"],
  );
});

Deno.test("Deno skill reader enforces reference boundaries and cancellation", async () => {
  const reader = createDenoSkillResourceReader();
  const controller = new AbortController();
  controller.abort(new Error("contract cancelled"));
  await assertRejects(
    () =>
      reader({
        skill: {
          name: "contract",
          description: "Contract skill",
          content: "",
          source: "project",
          sourcePath: "/tmp/contract",
          hasReferences: true,
        },
        path: "guide.md",
        signal: controller.signal,
      }),
    Error,
    "contract cancelled",
  );
  await assertRejects(
    () =>
      reader({
        skill: {
          name: "contract",
          description: "Contract skill",
          content: "",
          source: "project",
          sourcePath: "/tmp/contract",
          hasReferences: true,
        },
        path: "../secret",
        signal: new AbortController().signal,
      }),
    TypeError,
    "must remain inside references",
  );
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
  assert(!/^\s*(?:export\s+)?class\s/m.test(denoSource));
});
