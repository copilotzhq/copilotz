export * from "jsr:@oxian/oxian-js@0.21.0-rc.4/worker";
import type { createWorker } from "jsr:@oxian/oxian-js@0.21.0-rc.4/worker";

export type WorkerLifecycleCallbacks = Parameters<typeof createWorker>[1];
