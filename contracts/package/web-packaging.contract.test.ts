import assert from "node:assert/strict";
import { test } from "node:test";
import { moduleSpecifiers } from "../../scripts/check-plugin-boundaries.ts";
const root = new URL("../../", import.meta.url);
const config = JSON.parse(await Deno.readTextFile(new URL("deno.json", root)));

test("every web source entry and kit CSS is present in the npm publication archive", async () => {
  const output = await new Deno.Command("npm", {
    args: ["pack", "--dry-run", "--json", "--ignore-scripts"],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.equal(output.code, 0, new TextDecoder().decode(output.stderr));
  const files = new Set<string>(
    JSON.parse(new TextDecoder().decode(output.stdout))[0].files.map((
      file: { path: string },
    ) => file.path),
  );
  const manifest = JSON.parse(
    await Deno.readTextFile(new URL("package.json", root)),
  );
  assert.equal(manifest.version, config.version);
  assert.equal(manifest.name, config.name);
  assert.equal(
    manifest.exports["./web/kit/styles.css"],
    "./plugins/ui-kit/styles.css",
  );
  assert.ok(files.has("plugins/ui-kit/styles.css"));
  // The kit stylesheet is self-contained: KaTeX's CSS, fonts and license ship
  // inside it, so linked checkouts and installs resolve them the same way.
  assert.ok(files.has("plugins/ui-kit/katex/katex.css"));
  assert.ok(files.has("plugins/ui-kit/katex/LICENSE"));
  assert.ok(files.has("plugins/ui-kit/katex/fonts/KaTeX_Main-Regular.woff2"));
  assert.ok(config.publish.include.includes("plugins/ui-kit/katex/fonts/*.woff2"));
  assert.ok(![...files].some((file) => /\.test\.tsx?$/.test(file)));
  const visited = new Set<string>();
  async function visit(path: string): Promise<void> {
    if (visited.has(path)) return;
    visited.add(path);
    assert.ok(files.has(path), `Missing published dependency ${path}`);
    const source = await Deno.readTextFile(new URL(path, root));
    for (const specifier of moduleSpecifiers(source)) {
      const resolved = config.imports[specifier] ?? specifier;
      if (resolved.startsWith(".")) {
        const url = new URL(
          resolved,
          specifier.startsWith(".") ? new URL(path, root) : root,
        );
        await visit(url.pathname.slice(root.pathname.length));
      } else if (!specifier.startsWith("node:")) {
        const name = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0];
        assert.ok(
          manifest.dependencies[name] ?? manifest.peerDependencies[name],
          `npm dependency missing: ${specifier}`,
        );
      }
    }
  }
  for (
    const [path, target] of Object.entries(config.exports) as [string, string][]
  ) {
    assert.equal(manifest.exports[path], target);
    if (path.includes("web")) await visit(target.slice(2));
  }
});

test("web entries type check and execute in a consumer with no JSX compiler settings", async () => {
  const directory = await Deno.makeTempDir({ prefix: "web-consumer-" });
  try {
    const imports = Object.fromEntries(
      Object.entries(config.imports).map((
        [key, value],
      ) => [
        key,
        (value as string).startsWith(".")
          ? new URL(value as string, root).href
          : value,
      ]),
    );
    await Deno.writeTextFile(
      `${directory}/deno.json`,
      JSON.stringify({
        imports,
        lock: false,
        nodeModulesDir: "auto",
        minimumDependencyAge: config.minimumDependencyAge,
      }),
    );
    await Deno.writeTextFile(
      `${directory}/probe.ts`,
      `
      import React from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import { Field, Input, Tabs, TabsList, TabsTrigger, TabsContent } from "@copilotz/copilotz/web/kit";
      import { coreWebPlugin } from "@copilotz/copilotz/core/web";
      import { adminWebPlugin } from "@copilotz/copilotz/admin/web";
      import { usageWebPlugin } from "@copilotz/copilotz/usage/web";
      import { uiWebPlugin } from "@copilotz/copilotz/ui/web";
      import { reactRenderer } from "@copilotz/copilotz/web/react";
      const html = renderToStaticMarkup(React.createElement(Field, {label: "Name", children: (id: string) => React.createElement(Input, {id})}));
      if (!html.includes('data-slot="field"')) throw new Error(html);
      if (![coreWebPlugin,adminWebPlugin,usageWebPlugin,uiWebPlugin(),reactRenderer].every(item => item.id)) throw new Error("Missing entry");
      void [Tabs,TabsList,TabsTrigger,TabsContent];
      Deno.exit(0);
    `,
    );
    for (const command of ["check", "run"]) {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          command,
          "--config",
          `${directory}/deno.json`,
          ...(command === "run" ? ["--allow-read", "--allow-env"] : []),
          `${directory}/probe.ts`,
        ],
        cwd: directory,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
