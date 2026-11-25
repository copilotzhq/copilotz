import { loadTsx } from "./load-tsx.ts";

await loadTsx(() => import("./dialogs-matrix.tsx"));
