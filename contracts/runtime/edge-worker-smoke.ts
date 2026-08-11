import { runRuntimeNeutralSmoke } from "./runtime-neutral-smoke.ts";

export default Object.freeze({
  async fetch(): Promise<Response> {
    return Response.json(await runRuntimeNeutralSmoke());
  },
});
