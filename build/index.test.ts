import { assert, assertEquals, assertRejects } from "@std/assert";
import { build, generate } from "./index.ts";
import { createPluginRegistry } from "../runtime/plugins/index.ts";

async function fixture(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
) {
  const root = await Deno.makeTempDir({
    dir: new URL("./", import.meta.url).pathname,
  });
  try {
    for (
      const [path, text] of Object.entries({
        "copilotz.json": '{"id":"fixture","version":"1"}',
        ...files,
      })
    ) {
      await Deno.mkdir(root + "/" + path.split("/").slice(0, -1).join("/"), {
        recursive: true,
      });
      await Deno.writeTextFile(root + "/" + path, text);
    }
    await run(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("discovery is deterministic and never executes source", async () => {
  await fixture({
    "actions/zebra/index.ts":
      'throw new Error("must not execute"); export default {};',
    "resources/policy/default/index.ts": "export default {limit:2};",
    "actions/internal/helper.ts": "export const privateValue = 1;",
  }, async (root) => {
    const first = await generate(root);
    assertEquals(first, await generate(root));
    assert(first.includes('"zebra": entry0'));
    assert(!first.includes("helper"));
    await build(root, { sourceOnly: true });
    await build(root, { check: true });
    await Deno.writeTextFile(root + "/plugin.generated.ts", "stale");
    await assertRejects(() => build(root, { check: true }), Error, "stale");
  });
});

Deno.test("discovery rejects duplicate aliases and missing default exports", async () => {
  await fixture({
    "actions/foo-bar/index.ts": "export default {};",
    "actions/fooBar/index.ts": "export default {};",
  }, async (root) => {
    await assertRejects(
      () => generate(root),
      Error,
      "Duplicate actions.fooBar",
    );
  });
  await fixture(
    { "actions/foo/index.ts": "export const foo = {};" },
    async (root) => {
      await assertRejects(() => generate(root), Error, "default export");
    },
  );
});

Deno.test("built ESM executes through a separately imported runtime", async () => {
  await fixture({
    "actions/echo/index.ts":
      'import {defineAction} from "@copilotz/copilotz/actions"; export default defineAction({id:"fixture.echo",execute:(input:unknown)=>input});',
  }, async (root) => {
    await build(root);
    const plugin = (await import("file://" + root + "/dist/plugin.js")).default;
    const registry = createPluginRegistry({ plugins: [plugin] });
    assertEquals(
      await registry.actions.echo.execute("hello", {} as never),
      "hello",
    );
    const generated = await Deno.readTextFile(root + "/dist/plugin.js");
    assert(!generated.includes("readDir("));
    assert(!generated.includes("typescript@"));
  });
});
