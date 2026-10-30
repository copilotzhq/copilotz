/**
 * The computers plugin's contract, for plugins that build on it (apps, cloud):
 * the work a computer serves and its shapes (shared/workloads.ts). Other
 * plugins send it work by these names through `ctx.workers`, and call the
 * plugin's Actions by name.
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
