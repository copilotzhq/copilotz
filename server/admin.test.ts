import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { createAdminHandlers } from "./admin.ts";

Deno.test("createAdminHandlers delegates directly to admin ops and forwards configured agents", async () => {
  const calls: Record<string, unknown>[] = [];
  const expectedOverview = {
    threadTotals: { total: 1, active: 1, archived: 0 },
    queueTotals: {
      total: 0,
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      expired: 0,
      overwritten: 0,
    },
    messageTotals: { total: 0, toolCallMessages: 0 },
    participantTotals: { total: 0, humans: 0, agents: 0 },
    llmTotals: {
      totalCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 0,
    },
  };

  const copilotz = {
    ops: {
      getAdminOverview: async (options?: unknown) => {
        calls.push({ method: "getAdminOverview", options });
        return expectedOverview;
      },
      getAdminActivitySeries: async (options?: unknown) => {
        calls.push({ method: "getAdminActivitySeries", options });
        return [];
      },
      listAdminThreads: async (options?: unknown) => {
        calls.push({ method: "listAdminThreads", options });
        return [];
      },
      listAdminParticipants: async (options?: unknown) => {
        calls.push({ method: "listAdminParticipants", options });
        return [];
      },
      listAdminAgents: async (options?: unknown) => {
        calls.push({ method: "listAdminAgents", options });
        return [];
      },
    },
    config: {
      agents: [{
        id: "agent-alpha",
        name: "Agent Alpha",
        description: "Primary agent",
      }],
    },
  };

  const handlers = createAdminHandlers(copilotz as never);

  assertEquals(await handlers.getOverview({ namespace: "tenant-alpha" }), expectedOverview);
  await handlers.getActivitySeries({ interval: "day" });
  await handlers.listThreads({ search: "alpha" });
  await handlers.listParticipants({ participantType: "agent" });
  await handlers.listAgents({ search: "agent" });

  assertEquals(calls, [
    {
      method: "getAdminOverview",
      options: { namespace: "tenant-alpha" },
    },
    {
      method: "getAdminActivitySeries",
      options: { interval: "day" },
    },
    {
      method: "listAdminThreads",
      options: { search: "alpha" },
    },
    {
      method: "listAdminParticipants",
      options: { participantType: "agent" },
    },
    {
      method: "listAdminAgents",
      options: {
        search: "agent",
        configuredAgents: [{
          id: "agent-alpha",
          name: "Agent Alpha",
          description: "Primary agent",
        }],
      },
    },
  ]);
});
