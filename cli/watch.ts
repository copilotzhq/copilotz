import { existsSync, readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { regenerate } from "./run.ts";

/** Watches the app and its plugin tree. A timestamp scan also catches dropped filesystem events. */
export function watchApp(root: string, cli: string): void {
  const plugins = join(root, "plugins");
  let previous: string | undefined;
  const refresh = () => {
    try {
      const paths = [
        join(root, "app.ts"),
        ...(existsSync(plugins) ? readdirSync(plugins, { recursive: true, encoding: "utf8" }) : [])
          .sort().map((p) => join(plugins, p)),
      ];
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
