/**
 * Work (`@copilotz/work`): kanban boards and shared Markdown documents, in a
 * space, for people and agents. `boards` (a board's columns and cards, and
 * the tools agents move them with) and `documents` (Markdown with versions,
 * merged when two edit at once, and who has one open), each a plugin of its
 * own beside Copilotz's `chat` and `spaces`, which they require:
 *
 * ```ts
 * import { boards, documents } from "@copilotz/work";
 *
 * const runtime = await createRuntime({ store, plugins: [models, chat, ...access, boards, documents, app] });
 * ```
 *
 * Their web front ends are `@copilotz/work/web`; their shapes,
 * `@copilotz/work/contract`.
 */
export * from "./boards/mod.ts";
export * from "./documents/mod.ts";
