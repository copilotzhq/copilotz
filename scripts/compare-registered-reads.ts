/** Compare an untouched baseline checkout with this checkout, sequentially.
 * deno run -A scripts/compare-registered-reads.ts /absolute/baseline/root
 * The legacy call exists only in a temporary benchmark against that checkout.
 */
import { resolve, toFileUrl } from "@std/path";

const baseline = resolve(Deno.args[0] ?? "");
if (!Deno.args[0]) {
  throw new Error("Pass the untouched baseline checkout path.");
}
const root = new URL("../", import.meta.url);
const temporary = await Deno.makeTempDir({ prefix: "reads-comparison-" });
const script = new URL("./benchmark-registered-reads.ts", import.meta.url);
const worker = new URL(
  "./registered-read-benchmark-worker.ts",
  import.meta.url,
);
const loader = new URL(
  "../plugins/core/shared/turn-context.ts",
  import.meta.url,
);
const replace = (text: string, from: string, to: string) => {
  if (!text.includes(from)) throw new Error(`Benchmark seam changed: ${from}`);
  return text.replace(from, to);
};
try {
  const loaderPath = `${temporary}/loader.ts`;
  let loaderSource = (await Deno.readTextFile(loader)).replace(
    /from "(\.[^"]+)"/g,
    (_match, path) => `from "${new URL(path, loader).href}"`,
  );
  loaderSource = replace(
    loaderSource,
    'from "@copilotz/copilotz/collections/authoring"',
    `from "${new URL("runtime/collections/reads.ts", root).href}"`,
  );
  await Deno.writeTextFile(loaderPath, loaderSource);
  await Deno.writeTextFile(
    `${temporary}/worker.ts`,
    replace(
      await Deno.readTextFile(worker),
      '"../plugins/core/shared/turn-context.ts"',
      JSON.stringify(toFileUrl(loaderPath).href),
    ),
  );
  let source = (await Deno.readTextFile(script)).replace(
    /from "\.\.\/([^"]+)"/g,
    (_match, path) => `from "${toFileUrl(resolve(baseline, path)).href}"`,
  );
  source = replace(
    source,
    JSON.stringify(
      toFileUrl(resolve(baseline, "plugins/core/shared/turn-context.ts")).href,
    ),
    JSON.stringify(toFileUrl(loaderPath).href),
  );
  source = replace(
    source,
    '"./registered-read-benchmark-worker.ts"',
    '"./worker.ts"',
  );
  source = replace(
    source,
    ': await runtime.read(scope, "turnContext", input);',
    ": undefined;",
  );
  source = replace(
    source,
    'const read = () => select("owner");',
    'const read = () => runtime.readSnapshot({ namespace }, ({ collections }) => select("worker", collections));',
  );
  const beforePath = `${temporary}/before.ts`;
  await Deno.writeTextFile(beforePath, source);
  const run = async (config: string, path: string) => {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", config, path],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success) {
      throw new Error(new TextDecoder().decode(result.stderr));
    }
    return JSON.parse(new TextDecoder().decode(result.stdout));
  };
  const before = await run(resolve(baseline, "deno.json"), beforePath);
  const after = await run(new URL("deno.json", root).pathname, script.pathname);
  console.log(JSON.stringify({ baseline, before, after }, null, 2));
} finally {
  await Deno.remove(temporary, { recursive: true });
}
