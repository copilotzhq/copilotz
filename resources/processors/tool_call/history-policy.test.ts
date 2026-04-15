import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  DEFAULT_TOOL_HISTORY_VISIBILITY,
  projectToolResultForHistory,
} from "./history-policy.ts";

Deno.test("projectToolResultForHistory applies tool projector for public_result tools", async () => {
  const result = await projectToolResultForHistory(
    {
      key: "lookup_route",
      name: "Lookup Route",
      historyPolicy: {
        visibility: "public_result",
        projector: (args: unknown, output: unknown) => {
          const input = args as { origin: string; destination: string };
          const toolOutput = output as { routeId: string };
          return `Route resolved: ${input.origin} -> ${input.destination} (${toolOutput.routeId})`;
        },
      },
    },
    {
      origin: "Sao Paulo",
      destination: "Piracicaba",
    },
    { routeId: "route-123" },
    undefined,
  );

  assertEquals(result.visibility, "public_result");
  assertEquals(
    result.projectedOutput,
    "Route resolved: Sao Paulo -> Piracicaba (route-123)",
  );
});

Deno.test("projectToolResultForHistory defaults visibility to public_full", async () => {
  const result = await projectToolResultForHistory(
    {
      key: "start_session",
      name: "Start Session",
    },
    {},
    { sessionId: "session-1" },
    undefined,
  );

  assertEquals(result.visibility, DEFAULT_TOOL_HISTORY_VISIBILITY);
  assertEquals(result.projectedOutput, undefined);
});
