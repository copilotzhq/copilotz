/** deno run -A scripts/benchmark-subscriptions.ts [commits=100] [subscribers=100] */
import { fixture, reader } from "../runtime/testing/subscriptions.ts";
const commits = Number(Deno.args[0] ?? 100),
  subscribers = Number(Deno.args[1] ?? 100);
for (const count of [...new Set([0, subscribers])]) {
  const f = await fixture();
  try {
    const subscriptions = await Promise.all(
      Array.from(
        { length: count },
        () => f.observe(f.authority, "entry", { limit: 10 }),
      ),
    );
    const readers = subscriptions.map(reader);
    await Promise.all(readers.map((r) => r.next()));
    for (let i = 0; i < 10; i++) {
      await f.collections.entry.create({ id: `warm${i}` });
      await Promise.all(readers.map((r) => r.next()));
    }
    const before = f.counters(),
      latency: number[] = [],
      started = performance.now();
    for (let i = 0; i < commits; i++) {
      const start = performance.now();
      await f.collections.entry.create({
        id: `row${String(i).padStart(5, "0")}`,
      });
      latency.push(performance.now() - start);
      await Promise.all(readers.map((r) => r.next()));
    }
    const elapsed = performance.now() - started;
    latency.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        subscribers: count,
        commits,
        commitsPerSecond: commits * 1000 / elapsed,
        commitMeanMs: latency.reduce((a, b) => a + b, 0) / commits,
        commitP50Ms: latency[Math.floor(commits * .5)],
        commitP95Ms: latency[Math.floor(commits * .95)],
        sqlPerCommit: (f.counters().statements - before.statements) / commits,
        authorizationEvaluationsDuringCommits: f.counters().evaluations -
          before.evaluations,
      }),
    );
    subscriptions.forEach((s) => s.detach());
  } finally {
    await f.close();
  }
}
