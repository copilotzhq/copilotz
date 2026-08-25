import { assert, assertEquals } from "@std/assert";
import { validateConcretePlugin } from "./check-plugin-layout.ts";

const moduleDoc = `/** Example ownership.\n * @module\n */\n`;
const readme =
  `# Example\n\n## What it is\nA test.\n\n## Why it exists\nOwnership.\n\n## How to use it\nImport it.\n\n## How it works\nIt composes.\n`;

async function write(path: URL, content: string): Promise<void> {
  await Deno.mkdir(new URL("./", path), { recursive: true });
  await Deno.writeTextFile(path, content);
}

Deno.test("plugin layout accepts one documented concrete primitive", async () => {
  const directory = await Deno.makeTempDir();
  const plugins = new URL(`file://${directory}/`);
  const root = new URL("example/", plugins);
  const primitive = new URL("actions/run/", root);
  await write(new URL("README.md", root), readme);
  await write(new URL("index.ts", root), moduleDoc);
  await write(
    new URL("plugin.ts", root),
    `${moduleDoc}import { definePlugin } from "x";\nexport const plugin = definePlugin({ id: "x", version: "1" });\n`,
  );
  await write(new URL("plugin.test.ts", root), "export {};\n");
  await write(new URL("actions/index.ts", root), moduleDoc);
  await write(new URL("README.md", primitive), readme);
  await write(
    new URL("index.ts", primitive),
    `${moduleDoc}import { defineAction } from "x";\nexport const action = defineAction({ id: "x", execute() {} });\n`,
  );
  await write(new URL("index.test.ts", primitive), "export {};\n");

  assertEquals(await validateConcretePlugin(plugins, "example"), []);
});

Deno.test("plugin layout reports forwarding files and undocumented primitives", async () => {
  const directory = await Deno.makeTempDir();
  const plugins = new URL(`file://${directory}/`);
  const root = new URL("example/", plugins);
  const primitive = new URL("resources/agent/", root);
  await write(new URL("README.md", root), "# Incomplete\n");
  await write(new URL("index.ts", root), "export {};\n");
  await write(new URL("plugin.ts", root), "export {};\n");
  await write(new URL("plugin.test.ts", root), "export {};\n");
  await write(new URL("legacy.ts", root), "export {};\n");
  await write(new URL("resources/index.ts", root), "export {};\n");
  await write(new URL("index.ts", primitive), "export {};\n");

  const failures = await validateConcretePlugin(plugins, "example");
  assert(failures.some((failure) => failure.includes("legacy.ts")));
  assert(
    failures.some((failure) => failure.includes("missing leading @module")),
  );
  assert(
    failures.some((failure) => failure.includes("README.md: missing required")),
  );
  assert(
    failures.some((failure) =>
      failure.includes("index.test.ts: missing required")
    ),
  );
});
