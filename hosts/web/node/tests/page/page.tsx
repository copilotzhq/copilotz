/** A page to bundle: JSX, and a module it loads only when asked (a chunk of its own). */
export const page = <main>A page</main>;
export const later = (): Promise<{ later: string }> => import("./later.ts");
