/**
 * `boundaries`, for an app's tests: a plugin imports another of the app's
 * plugins only through its contract.ts, and only one it requires.
 */
import { assertEquals } from "@std/assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { definePlugin } from "../runtime/mod.ts";
import { boundaries, tempDir, test } from "./mod.ts";

/** An app's plugins folder, as files. */
function app(files: Record<string, string>): string {
  const root = join(tempDir(), "plugins");
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

test("an app's plugin imports another's contract only, and requires it", () => {
  const root = app({
    "billing/contract.ts": "export type Invoice = { total: number };",
    "billing/lib/money.ts": "export const cents = (n: number) => n * 100;",
    "sales/actions/close.ts": [
      'import type { Invoice } from "../../billing/contract.ts";',
      'import { cents } from "../../billing/lib/money.ts";',
      'import { open } from "../lib/open.ts";',
      '// import { never } from "../../billing/lib/never.ts";',
    ].join("\n"),
    "sales/lib/open.ts": "export const open = 1;",
    "sales/tests/close.test.ts": 'import { cents } from "../../billing/lib/money.ts";',
  });
  const billing = definePlugin({ name: "billing" });
  assertEquals(boundaries({ root, plugins: [billing, definePlugin({ name: "sales" })] }), [
    `sales/actions/close.ts → ../../billing/contract.ts: "sales" builds on "billing": add it to requires`,
    "sales/actions/close.ts → ../../billing/lib/money.ts: another plugin's code; import its contract.ts",
  ]);
  const sales = definePlugin({ name: "sales", requires: ["billing"] });
  assertEquals(boundaries({ root, plugins: [billing, sales] }), [
    "sales/actions/close.ts → ../../billing/lib/money.ts: another plugin's code; import its contract.ts",
  ]);
  // A folder named otherwise is mapped to its plugin.
  assertEquals(
    boundaries({
      root,
      plugins: [definePlugin({ name: "money" }), sales],
      folders: { billing: "money" },
    })
      .length,
    2,
  );
});
