import { assertEquals } from "jsr:@std/assert@1.0.13";
import { join } from "jsr:@std/path@1.1.2";

const repoRoot = join(import.meta.dirname!, "..");

Deno.test({
  name: "packed package preserves database operation types for consumers",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "copilotz-packed-types-",
    });
    try {
      const archive = join(tempDir, "copilotz.tgz");
      const denoDir = join(tempDir, "deno-cache");
      await run(
        [Deno.execPath(), "pack", "--allow-dirty", "--output", archive],
        repoRoot,
      );

      await Deno.writeTextFile(
        join(tempDir, "package.json"),
        JSON.stringify({
          private: true,
          dependencies: { "@copilotz/copilotz": `file:${archive}` },
        }),
      );
      await Deno.writeTextFile(
        join(tempDir, "deno.json"),
        JSON.stringify({ nodeModulesDir: "manual" }),
      );
      await Deno.writeTextFile(
        join(tempDir, ".npmrc"),
        "@jsr:registry=https://npm.jsr.io\n",
      );
      await Deno.writeTextFile(
        join(tempDir, "main.ts"),
        `import { createDatabase } from "npm:@copilotz/copilotz";

const db = await createDatabase({ url: ":memory:" });
const namespace: string = "tenant-a";
await db.ops.findOrCreateThread("thread-a", {
  namespace,
  name: "Sandbox job",
  participants: ["user-a", "agent-a"],
});
await db.ops.mutate.toolExecutions.create({
  id: crypto.randomUUID(),
  threadId: "thread-a",
  agentId: "agent-a",
  toolCallId: "call-a",
  tool: { id: "terminal", name: "Terminal" },
  args: { stdin: "pwd" },
  namespace,
});
const node = await db.ops.unsafeGraph.getNodeById("execution-a");
const metadata = node?.data?.metadata as Record<string, unknown> | undefined;
console.log(metadata, namespace);
await db.close();
`,
      );

      await run(
        [
          "npm",
          "install",
          "--ignore-scripts",
          "--cache",
          join(tempDir, "npm-cache"),
        ],
        tempDir,
      );
      await run(
        [Deno.execPath(), "check", "main.ts"],
        tempDir,
        { DENO_DIR: denoDir },
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

async function run(
  command: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<void> {
  const result = await new Deno.Command(command[0], {
    args: command.slice(1),
    cwd,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(
    result.success,
    true,
    `${command.join(" ")} failed\n${new TextDecoder().decode(result.stdout)}\n${
      new TextDecoder().decode(result.stderr)
    }`,
  );
}
