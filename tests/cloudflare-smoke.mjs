import { Miniflare } from "miniflare";

const scriptPath = process.argv[2];
if (!scriptPath) throw new Error("Cloudflare smoke requires a bundle path.");
const worker = new Miniflare({
  modules: true,
  scriptPath,
  compatibilityDate: "2026-08-05",
});
try {
  const response = await worker.dispatchFetch("https://smoke.test/");
  if (!response.ok) throw new Error(`Worker returned ${response.status}.`);
  const result = await response.json();
  if (
    JSON.stringify(result) !== JSON.stringify({
      plugin: "smoke.plugin",
      processor: "smoke.processor",
      bytes: [2, 3, 4],
    })
  ) {
    throw new Error(
      `Unexpected worker smoke result: ${JSON.stringify(result)}`,
    );
  }
  console.log(`copilotz-cloudflare-smoke:${JSON.stringify(result)}`);
} finally {
  await worker.dispose();
}
