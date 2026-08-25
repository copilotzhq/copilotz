export * from "@oxian/oxian-js/worker";
import type { createWorker } from "@oxian/oxian-js/worker";

export type WorkerLifecycleCallbacks = Parameters<typeof createWorker>[1];
