/** V1 package contract. Host-role output separation remains a later build slice. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import * as root from "../../index.ts";
import * as views from "@copilotz/copilotz/views";
import type {
  AnyViewDefinition,
  ViewContext,
  ViewDefinition,
  ViewHints,
  ViewMap,
  ViewReference,
  ViewShows,
} from "../../index.ts";

// These imports are part of the supported root surface, not deep implementation imports.
function compilePublicViewTypes(
  _any: AnyViewDefinition,
  _definition: ViewDefinition,
  _context: ViewContext,
  _hints: ViewHints,
  _map: ViewMap,
  _reference: ViewReference,
  _shows: ViewShows,
): void {}
void compilePublicViewTypes;

test("Views have a deliberate subpath mirrored by the package import map", async () => {
  const configuration = JSON.parse(
    await readFile(new URL("../../deno.json", import.meta.url), "utf8"),
  );
  assert.equal(configuration.exports["./views"], "./runtime/views/index.ts");
  assert.equal(
    configuration.imports["@copilotz/copilotz/views"],
    configuration.exports["./views"],
  );
  assert.equal(
    import.meta.resolve("@copilotz/copilotz/views"),
    new URL("../../runtime/views/index.ts", import.meta.url).href,
  );
});

test("root and View subpath expose identical portable View factories", () => {
  for (
    const name of [
      "defineView",
      "createViewResolver",
      "createTextRenderer",
    ] as const
  ) {
    assert.equal(typeof views[name], "function", name);
    assert.equal(root[name], views[name], name);
  }
  for (const [name, value] of Object.entries(views)) {
    assert.equal(
      (root as unknown as Record<string, unknown>)[name],
      value,
      name,
    );
  }
});
