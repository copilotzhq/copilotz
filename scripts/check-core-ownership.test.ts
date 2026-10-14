import { assertEquals } from "@std/assert";
import { coreOwnershipErrors } from "./check-core-ownership.ts";
Deno.test("Core ownership catches hidden instances without rejecting declaration factories", () => {
  assertEquals(
    coreOwnershipErrors(
      "plugins/core/authoring/server/index.ts",
      "export const action=defineAction({});",
    ).length,
    1,
  );
  assertEquals(
    coreOwnershipErrors(
      "plugins/core/authoring/define-tool/index.ts",
      "export function defineTool(){return defineAction({});}",
    ),
    [],
  );
  assertEquals(
    coreOwnershipErrors(
      "plugins/core/resources/agents/default/index.ts",
      "export function defineAgent(){}",
    ).length,
    1,
  );
  assertEquals(
    coreOwnershipErrors(
      "plugins/core/resources/toolResults/default/index.ts",
      "const policy={maxTokens:2000};export default policy;",
    ),
    [],
  );
});
Deno.test("A shared file cannot hide audited single-owner behavior beside a reused helper", () => {
  const source =
    "export function reused(){};export function coreToolTerminal(){}";
  assertEquals(
    coreOwnershipErrors("plugins/core/shared/tool-plan.ts", source).length,
    1,
  );
  assertEquals(
    coreOwnershipErrors(
      "plugins/core/processors/project-tool-result/terminal.ts",
      source,
    ),
    [],
  );
});
