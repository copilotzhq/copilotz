import { loadTsx } from "./load-tsx.ts";

await loadTsx(() => import("./interactions.tsx"));
