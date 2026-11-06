/**
 * Work's front ends, for the browser: boards' (a space's Board tab, a board's page, cards) and
 * documents' (a space's Documents tab, the editor, history). Add them beside the web shell's:
 *
 * ```ts
 * await web({ plugins: [webShell, chatWeb, spacesWeb, boardsWeb, documentsWeb], root });
 * ```
 */
export * from "./boards/web.tsx";
export * from "./documents/web.tsx";
