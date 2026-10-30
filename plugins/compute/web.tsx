/**
 * Compute's front ends, for the browser: computers' (a space's computers,
 * their terminal, jobs, files and previews), cloud computers' (making one,
 * its state, waking it) and apps' (publishing a job). Add them beside the
 * web shell's:
 *
 * ```ts
 * await web({ plugins: [webShell, chatWeb, spacesWeb, computersWeb, cloudWeb, appsWeb], root });
 * ```
 */
export * from "./computers/web.tsx";
export * from "./cloud/web.tsx";
export * from "./apps/web.tsx";
