/**
 * Work's front ends, for the browser (`@copilotz/work/web`): boards' (a space's Board tab, a
 * board's page, cards) and documents' (a space's Documents tab, the editor, history). Add them
 * beside the web shell's:
 *
 * ```ts
 * import { boardsWeb, documentsWeb } from "@copilotz/work/web";
 *
 * await web({ plugins: [webShell, chatWeb, spacesWeb, boardsWeb, documentsWeb], root });
 * ```
 */
export * from "./boards/web.tsx";
export * from "./documents/web.tsx";
