/**
 * The routines plugin's contract: what plugins built on it may import: the
 * shapes of a routine, a run of one, and a schedule. The rest is reached by
 * name: its queries (`routine.list`, `routine.runs`), its Actions
 * (`routine.create`, `routine.update`, `routine.pause`, `routine.resume`,
 * `routine.delete`, `routine.run`) and the tools agents use
 * (`schedule_routine`, `list_routines`, `cancel_routine`). On the web, the
 * `routinePanels` resource: a View drawn on a routine's page, given the routine.
 */
export type { Listed as ListedRoutine, Routine } from "./collections/routine.ts";
export type { RoutineRun } from "./collections/run.ts";
export type { Schedule } from "./shared/schedule.ts";

/** A `routinePanels` resource: a View drawn on a routine's page. */
export type RoutinePanel = { view: string; order?: number };
