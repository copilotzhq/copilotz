/** Generate or check all declared library plugin roots using the public compiler. @module */
import { build } from "../build/index.ts";
for await (
  const entry of Deno.readDir(new URL("../plugins/", import.meta.url))
) {
  if (!entry.isDirectory) continue;
  const root = new URL(`../plugins/${entry.name}/`, import.meta.url).pathname;
  if (!await Deno.stat(root + "copilotz.json").catch(() => null)) continue;
  await build(root, { sourceOnly: true, check: Deno.args.includes("--check") });
}
