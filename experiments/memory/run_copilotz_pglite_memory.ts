type CaseResult = {
  name: string;
  mode: string;
  url: string;
  snapshotPath?: string;
  maxRssMb: number;
  exitCode: number;
  rows: Array<{ label: string; rssMb: number; atMs: number }>;
  stderr: string;
};

const root = `/tmp/copilotz-pglite-memory-${Date.now()}-${crypto.randomUUID()}`;
await Deno.mkdir(root, { recursive: true });

function fileUrl(path: string): string {
  return `file://${path}`;
}

function mbFromKb(kb: number): number {
  return Math.round((kb / 1024) * 10) / 10;
}

async function getRssMb(pid: number): Promise<number | undefined> {
  const ps = new Deno.Command("ps", {
    args: ["-o", "rss=", "-p", String(pid)],
    stdout: "piped",
    stderr: "null",
  });
  const output = await ps.output();
  if (!output.success) return undefined;
  const text = new TextDecoder().decode(output.stdout).trim();
  const kb = Number(text);
  return Number.isFinite(kb) && kb > 0 ? mbFromKb(kb) : undefined;
}

async function runCase(
  name: string,
  args: string[],
): Promise<CaseResult> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--v8-flags=--expose-gc",
      "experiments/memory/copilotz_pglite_memory_case.ts",
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  let maxRssMb = 0;
  let done = false;
  const statusPromise = child.status.then((status) => {
    done = true;
    return status;
  });

  while (!done) {
    const rss = await getRssMb(child.pid);
    if (rss != null) maxRssMb = Math.max(maxRssMb, rss);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const [status, stdout, stderr] = await Promise.all([
    statusPromise,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const lastLine = stdout.trim().split("\n").at(-1) ?? "{}";
  const parsed = JSON.parse(lastLine) as Omit<
    CaseResult,
    "name" | "maxRssMb" | "exitCode" | "stderr"
  >;

  return {
    name,
    ...parsed,
    maxRssMb,
    exitCode: status.code,
    stderr,
  };
}

const freshUrl = fileUrl(`${root}/fresh.db`);
const preparedUrl = fileUrl(`${root}/prepared.db`);
const snapshotSourceUrl = fileUrl(`${root}/snapshot-source.db`);
const restoreUrl = fileUrl(`${root}/restore-target.db`);
const snapshotPath = `${root}/snapshot.pglite.tar.gz`;

const results: CaseResult[] = [];

results.push(await runCase("memory", ["--mode=memory", "--url=:memory:"]));
results.push(
  await runCase("fresh-file", [
    "--mode=fresh-file",
    `--url=${freshUrl}`,
  ]),
);

await runCase("prepare-only", [
  "--mode=prepare-only",
  `--url=${preparedUrl}`,
]);
results.push(
  await runCase("existing-file-after-prepare", [
    "--mode=existing-file",
    `--url=${preparedUrl}`,
  ]),
);

await runCase("make-snapshot", [
  "--mode=make-snapshot",
  `--url=${snapshotSourceUrl}`,
  `--snapshot=${snapshotPath}`,
]);
results.push(
  await runCase("restore-from-snapshot", [
    "--mode=restore",
    `--url=${restoreUrl}`,
    `--snapshot=${snapshotPath}`,
  ]),
);

console.log(JSON.stringify(
  {
    root,
    results,
  },
  null,
  2,
));

console.log("\nSummary:");
console.log("| Case | Peak RSS MB | After create MB | After select MB |");
console.log("| --- | ---: | ---: | ---: |");
for (const result of results) {
  const afterCreate = result.rows.find((row) =>
    row.label === "after-createCopilotz"
  )?.rssMb;
  const afterSelect = result.rows.find((row) => row.label === "after-select")
    ?.rssMb;
  console.log(
    `| ${result.name} | ${result.maxRssMb} | ${afterCreate ?? "-"} | ${
      afterSelect ?? "-"
    } |`,
  );
}
