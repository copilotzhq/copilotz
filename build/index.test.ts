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
    "shared/helper.ts": "export const privateValue = 1;",
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

Deno.test("manifest dependencies generate direct imports and shared modules are not discovered", async () => {
  await fixture({
    "copilotz.json": JSON.stringify({
      id: "dependent",
      version: "1",
      plugins: [{ from: "./shared/base.ts", export: "default" }],
    }),
    "shared/base.ts":
      'import {definePlugin} from "@copilotz/copilotz/plugins"; export default definePlugin({id:"base",version:"1"});',
    "shared/actions/not-a-primitive/index.ts":
      'throw new Error("not discovered");',
  }, async (root) => {
    const source = await generate(root);
    assert(
      source.includes(
        'import { default as dependency0 } from "./shared/base.ts";',
      ),
    );
    assert(source.includes("plugins: [dependency0]"));
    assert(!source.includes("not-a-primitive"));
    await build(root);
    const plugin = (await import("file://" + root + "/dist/plugin.js")).default;
    assertEquals(plugin.plugins.map((p: { id: string }) => p.id), ["base"]);
  });
});
Deno.test("build rejects removed folder conventions and duplicate plugin imports", async () => {
  await fixture(
    { "dependencies/old/index.ts": "export default {}" },
    (root) =>
      assertRejects(() => generate(root), Error, "manifest plugin imports")
        .then(() => undefined),
  );
  await fixture(
    {
      "copilotz.json": JSON.stringify({
        id: "bad",
        version: "1",
        plugins: [{ from: "x", export: "plugin" }, {
          from: "x",
          export: "plugin",
        }],
      }),
    },
    (root) =>
      assertRejects(() => generate(root), Error, "Duplicate plugin import")
        .then(() => undefined),
  );
});

Deno.test("build rejects missing dependency exports and cyclic plugin identities", async () => {
  for (const cyclic of [false, true]) {
    await fixture({
      "copilotz.json": JSON.stringify({
        id: "dependent",
        version: "1",
        plugins: [{
          from: "./shared/base.ts",
          export: cyclic ? "default" : "missing",
        }],
      }),
      "shared/base.ts":
        'import {definePlugin} from "@copilotz/copilotz/plugins"; export default definePlugin({id:"dependent",version:"1"});',
    }, async (root) => {
      await assertRejects(
        () => build(root),
        Error,
        cyclic ? "composition validation failed" : "type check failed",
      );
      assertEquals(
        await Deno.stat(root + "/dist/plugin.js").catch(() => null),
        null,
      );
    });
  }
});
