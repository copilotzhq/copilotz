/** nice -n 10 deno run -A scripts/report-turn.ts before.json after.json */
type Stage = {
  ms: number;
  commands: number;
  sql: number;
  transactions: number;
  roundTrips: number;
  hostCalls: number;
  deliveries: number;
};
type Sample = {
  scenario: string;
  stages: Record<string, Stage>;
  deliveries?: { consumer_id: string; ms: string | number; status: string }[];
};
type Report = {
  backend: string;
  results: Sample[];
  idle: Stage & { commandsPerSecond: number };
};
const reports: Report[] = await Promise.all(
  Deno.args.map(async (file) =>
    JSON.parse(await Deno.readTextFile(file)) as Report
  ),
);
if (reports.length !== 2) throw new Error("Pass before.json after.json");
if (reports[0].backend !== reports[1].backend) {
  throw new Error("Backends differ");
}
const median = (values: number[]) => {
  values.sort((a, b) => a - b);
  return values[Math.ceil(values.length / 2) - 1] ?? NaN;
};
const number = (n: number) => Number.isFinite(n) ? n.toFixed(1) : "—";
const pair = (values: number[]) => values.map(number).join(" → ");
console.log(
  `Backend: ${
    reports[0].backend
  }. Cells show before → after; cumulative medians from send, five samples by default. SQL round trips include estimated transaction boundaries.\n`,
);
for (const scenario of ["plain", "tool", "noop"]) {
  console.log(`**${scenario}**\n`);
  console.log(
    "| Stage | ms | Owner commands | SQL calls | SQL round trips (est.) | Host calls | Deliveries |",
  );
  console.log("|---|---:|---:|---:|---:|---:|---:|");
  for (
    const stage of scenario === "noop" ? ["turnSettled"] : [
      "sendAccepted",
      "messageVisible",
      "modelStarted",
      "replyVisible",
      "turnSettled",
      "allDeliveriesSettled",
    ]
  ) {
    const metrics = ([
      "ms",
      "commands",
      "sql",
      "roundTrips",
      "hostCalls",
      "deliveries",
    ] as const).map((metric) =>
      pair(
        reports.map((report) =>
          median(
            report.results.filter((r) => r.scenario === scenario).map((r) =>
              r.stages[stage][metric]
            ),
          )
        ),
      )
    );
    console.log(`| ${stage} | ${metrics.join(" | ")} |`);
  }
  console.log(
    `\nNo-op created → settled p50 (includes queueing): ${
      pair(reports.map((report) =>
        median(
          report.results.filter((r) => r.scenario === scenario).flatMap((r) =>
            (r.deliveries ?? []).filter((d) =>
              d.consumer_id === "processor:perf.noop"
            ).map((d) => Number(d.ms))
          ),
        )
      ))
    } ms.\n`,
  );
}
console.log(
  `Idle commands/s: ${
    pair(reports.map((r) => r.idle.commandsPerSecond))
  }. Idle SQL calls: ${pair(reports.map((r) => r.idle.sql))}.\n`,
);
