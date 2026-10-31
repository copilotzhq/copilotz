/**
 * The computers plugin's contract, for plugins that build on it (apps, cloud):
 * the work a computer serves and its shapes (shared/workloads.ts), and a
 * space's environment as people read it (`envVar`). Other plugins send it
 * work by these names through `ctx.workers`, and call the plugin's Actions
 * by name.
 */
export {
  type ArchiveInput,
  type Failed,
  type HttpRequestHead,
  type HttpResponseHead,
  type Job,
  type JobsStartInput,
  type Scope,
  WORK,
} from "./shared/workloads.ts";
export type { EnvVar } from "./collections/env-var.ts";

/**
 * What a View the computers' web front end draws under a space's
 * environment (its `envActions` resource) is given: the space, and when its
 * environment was last changed from that page.
 */
export type EnvChanged = { _id: string; changed?: string };
