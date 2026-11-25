import { readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { regenerate } from "./run.ts";

// Imports can take a declaration's type outside plugins/. Skip installed packages
// and build output, including the declaration gen itself writes at the app root.
function sources(dir: string, plugin = false): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (!plugin && (name.startsWith(".") || name === "node_modules" || name === "dist")) continue;
    const path = join(dir, name);
    if (entry.isDirectory()) {
      if (plugin) files.push(path);
      files.push(...sources(path, plugin || name === "plugins"));
    } else if (plugin || (name !== "copilotz-env.d.ts" && /(?:\.[cm]?tsx?|\.jsonc?)$/.test(name))) {
      files.push(path);
    }
  }
  return files;
}

/** Watches the app and its plugin tree. A timestamp scan also catches dropped filesystem events. */
export function watchApp(root: string, cli: string): void {
  const plugins = join(root, "plugins");
  let previous: string | undefined;
  const refresh = () => {
    try {
      const paths = sources(root).sort();
      const state = paths.map((p) => {
        const stat = statSync(p, { throwIfNoEntry: false });
        return [p, stat?.mtimeMs, stat?.size];
      });
      const current = JSON.stringify(state);
      if (current === previous) return;
      previous = current;
      regenerate(root, cli);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
  };
  let timer: ReturnType<typeof setTimeout>;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 60);
  };
  try {
    const tree = watch(plugins, { recursive: true }, changed);
    tree.on("error", () => tree.close());
    const app = watch(root, (_, file) => {
      if (file === "app.ts") changed();
    });
    app.on("error", () => app.close());
  } catch {
    // A filesystem without recursive watch still gets the scan below.
  }
  refresh();
  setInterval(refresh, 2000);
}
