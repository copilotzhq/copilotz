/** Build-host validation. Imports declarations without starting an application. @module */
import { pathToFileURL } from "node:url";
import {
  createPluginRegistry,
  isCopilotzPlugin,
} from "../runtime/plugins/index.ts";
export async function validatePlugin(entry: string): Promise<void> {
  const { default: plugin } = await import(pathToFileURL(entry).href);
  if (!isCopilotzPlugin(plugin)) {
    throw new TypeError("Generated entry must export a plugin.");
  }
  createPluginRegistry({ plugins: [plugin] });
}
if (import.meta.main) await validatePlugin(Deno.args[0]);
