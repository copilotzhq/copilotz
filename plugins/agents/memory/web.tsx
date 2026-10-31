/**
 * Memory's web front end, for the browser: what agents remember (the
 * `memories` View, as the terminal's `/memories` lists it: ★ for core
 * memories, always in mind). With spaces' front end, it's a space's
 * Memories tab: what was learned there (spaces' `spaceTabs` resource, named
 * here); at `/memories`, everything. Each memory moves to another space,
 * from its menu or the command palette (the web shell's `palette`), through
 * spaces' picker (`space.pick`, by name). Add it beside the web shell.
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { memoriesView } from "./views/web/memories.tsx";
import { memoryPaletteView } from "./views/web/palette.tsx";
import { memoryPickView } from "./views/web/pick.tsx";

export const memoryWeb: Plugin = definePlugin({
  name: "memory-web",
  requires: ["memory", "web-shell"],
  views: {
    memories: { web: memoriesView },
    "memory.palette": { web: memoryPaletteView },
    "memory.pick": { web: memoryPickView },
  },
  resources: {
    spaceTabs: {
      memories: {
        title: "Memories",
        view: "memories",
        icon: "sparkles",
        under: "settings",
        order: 20,
      },
    },
    palette: { memory: { view: "memory.palette", order: 40 } },
  },
});
