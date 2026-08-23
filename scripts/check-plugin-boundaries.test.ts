import { assert, assertEquals } from "@std/assert";
import {
  findPluginBoundaryFailures,
  moduleSpecifiers,
} from "./check-plugin-boundaries.ts";

const mappings = Object.freeze({
  imports: Object.freeze({
    "@copilotz/copilotz/plugins": "./runtime/plugins/index.ts",
    "@copilotz/copilotz/core": "./plugins/core/index.ts",
  }),
  exports: Object.freeze({
    ".": "./index.ts",
    "./plugins": "./runtime/plugins/index.ts",
    "./core": "./plugins/core/index.ts",
  }),
});

Deno.test("module specifier parser covers static, export, side-effect, and literal dynamic forms", () => {
  assertEquals(
    moduleSpecifiers(`
    import type { A } from "./a.ts";
    export { B } from './b.ts';
    import "./side.ts";
    const loaded = import("./dynamic.ts");
    // import "./comment.ts";
    const text = 'import("./string.ts")';
  `),
    ["./a.ts", "./b.ts", "./side.ts", "./dynamic.ts"],
  );
});

Deno.test("runtime transitive graph rejects every concrete-plugin import form", () => {
  const cases = [
    `import { corePlugin } from "../plugins/core/index.ts";`,
    `import { corePlugin } from "@copilotz/copilotz/core";`,
    `import "../plugins/core/index.ts";`,
    `const core = import("../plugins/core/index.ts");`,
    `import { corePlugin } from "@copilotz/copilotz";`,
  ];
  for (const [index, text] of cases.entries()) {
    const failures = findPluginBoundaryFailures([
      { path: `runtime/case-${index}.ts`, text },
      { path: "index.ts", text: `export * from "./plugins/core/index.ts";` },
      { path: "plugins/core/index.ts", text: "export const corePlugin = {};" },
    ], mappings);
    assert(
      failures.some((failure) =>
        failure.includes("runtime reaches concrete plugin")
      ),
      failures.join("\n"),
    );
  }
});

Deno.test("runtime generic plugin contract remains allowed and unknown self paths fail", () => {
  assertEquals(
    findPluginBoundaryFailures([
      {
        path: "runtime/example.ts",
        text: `import { definePlugin } from "@copilotz/copilotz/plugins";`,
      },
      {
        path: "runtime/plugins/index.ts",
        text: "export const definePlugin = 1;",
      },
    ], mappings),
    [],
  );
  const failures = findPluginBoundaryFailures([
    {
      path: "runtime/example.ts",
      text: `import "@copilotz/copilotz/not-exported";`,
    },
  ], mappings);
  assert(
    failures.some((failure) => failure.includes("unresolved internal self")),
  );
});

Deno.test("plugin production files cannot use relative runtime imports", () => {
  const failures = findPluginBoundaryFailures([
    {
      path: "plugins/example/index.ts",
      text: `export { definePlugin } from "../../runtime/plugins/index.ts";`,
    },
    {
      path: "runtime/plugins/index.ts",
      text: "export const definePlugin = 1;",
    },
  ], mappings);
  assert(
    failures.some((failure) => failure.includes("relative-imports runtime")),
  );
});
