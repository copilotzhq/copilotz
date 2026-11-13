/**
 * Compute's front ends, for the browser: computers' (a space's computers,
 * their terminal, jobs, files and previews). Add them beside the web shell's:
 *
 * ```ts
 * await web({ plugins: [webShell, chatWeb, spacesWeb, computersWeb], root });
 * ```
 */
export * from "./computers/web.tsx";
