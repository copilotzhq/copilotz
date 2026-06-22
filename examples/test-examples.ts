/**
 * Deterministic examples test runner.
 *
 * This keeps the examples directory honest without requiring provider API keys:
 * every example is type-checked, and self-contained E2E examples are executed.
 *
 * Run with:
 *   deno task test:examples
 */

type Step = {
  name: string;
  args: string[];
};

const decoder = new TextDecoder();
const deno = Deno.execPath();

async function listExampleFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir("examples")) {
    if (entry.isFile && entry.name.endsWith(".ts")) {
      files.push(`examples/${entry.name}`);
    }
  }
  return files.sort();
}

async function runStep(step: Step): Promise<void> {
  const command = new Deno.Command(deno, {
    args: step.args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const stdout = decoder.decode(output.stdout);
  const stderr = decoder.decode(output.stderr);

  if (stdout.trim().length > 0) {
    console.log(stdout.trimEnd());
  }
  if (stderr.trim().length > 0) {
    console.log(stderr.trimEnd());
  }

  if (!output.success) {
    throw new Error(
      `${step.name} failed with exit code ${output.code}`,
    );
  }
}

const exampleFiles = await listExampleFiles();
const runnableExamples = [
  "examples/end-to-end-persistence.ts",
  "examples/tool-call-e2e.ts",
];

const steps: Step[] = [
  {
    name: "type-check examples",
    args: ["check", ...exampleFiles],
  },
  ...runnableExamples.map((file): Step => ({
    name: `run ${file}`,
    args: ["run", "-A", file],
  })),
];

const startedAt = Date.now();
for (const step of steps) {
  console.log(`\n==> ${step.name}`);
  await runStep(step);
}

console.log(
  `\nExamples test runner passed (${steps.length} steps, ${
    Date.now() - startedAt
  }ms).`,
);
