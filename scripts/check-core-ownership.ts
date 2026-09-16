/** Checks Core's declaration/instance boundary; semantic helper ownership is reviewed separately. */
import ts from "typescript";

export function coreOwnershipErrors(path: string, source: string): string[] {
  const errors: string[] = [];
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const authoring = path.includes("/authoring/");
  const instance = /\/(?:resources|adapters)\/[^/]+\/[^/]+\/index\.ts$/.test(
    path,
  );
  let hasDefault = false;
  for (const statement of tree.statements) {
    if (ts.isExportAssignment(statement)) hasDefault = true;
    if (authoring && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (
          init && ts.isCallExpression(init) &&
          /^(defineAction|defineProcessor|defineCollection|definePlugin|createHttpAdapter)$/
            .test(init.expression.getText(tree))
        ) {
          errors.push(
            `${path}: primitive instances belong to their primitive modules, not authoring.`,
          );
        }
      }
    }
  }
  if (instance && !hasDefault) {
    errors.push(
      `${path}: an instance module must own and default-export its value; declaration helpers belong in authoring.`,
    );
  }
  const localOnly: Record<string, string> = {
    prepareContextContributions: "processors/message-router/",
    renderContextContent: "processors/message-router/",
    validateCoreToolPlan: "processors/project-text-result/",
    snapshotToolStageHistory: "processors/project-text-result/",
    snapshotToolStageActionIds: "processors/project-text-result/",
    snapshotRootTools: "processors/project-text-result/",
    coreToolTerminal: "processors/project-tool-result/",
  };
  for (const statement of tree.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const owner = localOnly[statement.name.text];
      if (owner && !path.includes(owner)) {
        errors.push(`${path}: ${statement.name.text} belongs to ${owner}`);
      }
    }
  }
  if (
    path.includes("/shared/") &&
    /\b(?:LEGACY_RUNTIME_KEYS|LEGACY_MEMORY_KEYS|DROPPED_LEGACY_KEYS|MemoryThreadMetadata|setChannelContext)\b/
      .test(source)
  ) {
    errors.push(
      `${path}: legacy or foreign-domain thread policy must not live in Core shared code.`,
    );
  }
  return errors;
}

if (import.meta.main) {
  const failures: string[] = [];
  async function walk(directory: string): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      if (entry.name === "testing" || entry.name === "tests") continue;
      const path = directory + "/" + entry.name;
      if (entry.isDirectory) await walk(path);
      else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) {
        failures.push(
          ...coreOwnershipErrors(path, await Deno.readTextFile(path)),
        );
      }
    }
  }
  await walk("plugins/core");
  await walk("plugins/core-http");
  if (failures.length) throw new Error(failures.join("\n"));
  console.log(
    "Core authoring/instance boundaries and audited helper owners passed.",
  );
}
