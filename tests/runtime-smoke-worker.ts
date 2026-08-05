import { runRuntimeSmoke } from "./runtime-smoke.ts";

export default {
  async fetch(): Promise<Response> {
    return Response.json(await runRuntimeSmoke());
  },
};
