import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  DEFAULT_TOOL_HISTORY_VISIBILITY,
  projectToolResultForHistory,
} from "./history-policy.ts";

Deno.test("projectToolResultForHistory preserves explicit public visibility", async () => {
  const result = await projectToolResultForHistory(
    {
      key: "lookup_route",
      name: "Lookup Route",
      historyPolicy: {
        visibility: "public",
      },
    },
    {
      origin: "Sao Paulo",
      destination: "Piracicaba",
    },
    { routeId: "route-123" },
    undefined,
  );

  assertEquals(result.visibility, "public");
});

Deno.test("projectToolResultForHistory defaults visibility to public_status", async () => {
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
  assertEquals(result.visibility, "public_status");
});
