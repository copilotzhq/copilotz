import { runtime } from "../../../testing/mod.ts";

/** Load a JSX test dependency on each of the supported test runtimes. */
export async function loadTsx<T>(load: () => Promise<T>): Promise<T> {
  let hooks;
  if (runtime === "node") {
    const { registerHooks } = await import("node:module");
    const { readFileSync } = await import("node:fs");
    const { transformSync } = await import("esbuild");
    hooks = registerHooks({
      load(url, context, next) {
        if (!url.endsWith(".tsx")) return next(url, context);
        const source = transformSync(readFileSync(new URL(url), "utf8"), {
          loader: "tsx",
          jsx: "automatic",
          format: "esm",
          sourcefile: url,
        }).code;
        return { format: "module", source, shortCircuit: true };
      },
    });
  }
  try {
    return await load();
  } finally {
    hooks?.deregister();
  }
}
