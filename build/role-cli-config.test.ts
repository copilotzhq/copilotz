import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const cli = new URL("./index.ts", import.meta.url).pathname;
const packageConfig = new URL("../deno.json", import.meta.url).pathname;

async function fixture(run: (root: string) => Promise<void>) {
  const root = await Deno.makeTempDir({ prefix: "role-cli-config-" });
  try {
    await Deno.writeTextFile(
      root + "/entry.ts",
      'export { value } from "chosen";',
    );
    await Deno.writeTextFile(
      root + "/chosen.ts",
      'export const value = "explicit";',
    );
    await Deno.writeTextFile(
      root + "/wrong.ts",
      'export const value = "discovered";',
    );
    await Deno.writeTextFile(
      root + "/deno.json",
      JSON.stringify({
        imports: { chosen: "./wrong.ts" },
      }),
    );
    await Deno.writeTextFile(
      root + "/selected.json",
      JSON.stringify({
        imports: { chosen: "./chosen.ts" },
      }),
    );
    await run(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}
function bundle(root: string, config: string) {
  return new Deno.Command(Deno.execPath(), {
    cwd: root,
    args: [
      "run",
      "-A",
      "--config",
      packageConfig,
      cli,
      "bundle",
      "entry.ts",
      "--role=worker",
      "--output=worker.js",
      "--config=" + config,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
}

Deno.test("worker bundle CLI forwards explicit config instead of discovered config", async () => {
  await fixture(async (root) => {
    const result = await bundle(root, "selected.json");
    assert(result.success, new TextDecoder().decode(result.stderr));
    const artifact = await import("file://" + root + "/worker.js");
    assertEquals(artifact.value, "explicit");
    const graph = JSON.parse(
      await Deno.readTextFile(root + "/worker.js.graph.json"),
    );
    assert(
      graph.modules.some((m: { source: string }) =>
        m.source.endsWith("/chosen.ts")
      ),
    );
    assert(
      !graph.modules.some((m: { source: string }) =>
        m.source.endsWith("/wrong.ts")
      ),
    );
  });
});

Deno.test("worker bundle CLI refuses invalid explicit config without replacing artifacts", async () => {
  await fixture(async (root) => {
    await Deno.writeTextFile(root + "/invalid.json", "{");
    for (
      const [config, message] of [
        ["invalid.json", "Invalid role build config:"],
        ["missing.json", "No such file or directory"],
        ["", "[--config=path]"],
      ]
    ) {
      await Deno.writeTextFile(root + "/worker.js", "previous artifact");
      await Deno.writeTextFile(
        root + "/worker.js.graph.json",
        "previous graph",
      );
      const result = await bundle(root, config);
      assertEquals(result.success, false);
      assertStringIncludes(new TextDecoder().decode(result.stderr), message);
      assertEquals(
        await Deno.readTextFile(root + "/worker.js"),
        "previous artifact",
      );
      assertEquals(
        await Deno.readTextFile(root + "/worker.js.graph.json"),
        "previous graph",
      );
    }
  });
});
