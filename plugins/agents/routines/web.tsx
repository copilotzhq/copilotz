/**
 * Routines' web front end, for the browser: a space's Routines tab
 * (spaces' `spaceTabs`: each routine who it asks, when it runs next and
 * how its last run went; "Run now", pausing and resuming from its row; a new
 * one with a friendly schedule picker, from scratch or an example), a
 * routine's page (`/routine/<id>`: what it does, its next runs, its runs
 * with their chats; changed in place, taken over when its maker left), the
 * command palette's (the web shell's `palette`), and a routine an agent made
 * from a conversation (chat's `toolViews` for `schedule_routine`). Add it
 * beside the web shell:
 *
 * ```ts
 * await web({ plugins: [webShell, chatWeb, spacesWeb, routinesWeb], root });
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { routinesView } from "./views/web/list.tsx";
import { newRoutineView } from "./views/web/new.tsx";
import { routineView } from "./views/web/page.tsx";
import { routinePaletteView } from "./views/web/palette.tsx";
import { routineStepView } from "./views/web/step.tsx";

export const routinesWeb: Plugin = definePlugin({
  name: "routines-web",
  requires: ["web-shell"],
  views: {
    routines: { web: routinesView },
    routine: { web: routineView },
    "routine.new": { web: newRoutineView },
    "routine.palette": { web: routinePaletteView },
    "routine.step": { web: routineStepView },
  },
  resources: {
    spaceTabs: { routines: { title: "Routines", view: "routines", icon: "refresh", order: 40 } },
    palette: { routines: { view: "routine.palette", order: 46 } },
    toolViews: { schedule_routine: "routine.step" },
  },
});
