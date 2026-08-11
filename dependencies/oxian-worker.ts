export * from "jsr:@oxian/oxian-js@0.21.0-rc.2/worker";
import type { createWorker } from "jsr:@oxian/oxian-js@0.21.0-rc.2/worker";

export type WorkerLifecycleCallbacks = Parameters<typeof createWorker>[1];
