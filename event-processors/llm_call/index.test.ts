import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { resolveAgentResponseTarget } from "./index.ts";

Deno.test("resolveAgentResponseTarget ignores self mentions and falls back to sender", () => {
  const result = resolveAgentResponseTarget(
    "@Researcher I can take it from here.",
    {
      id: "researcher",
      name: "Researcher",
    },
    {
      metadata: {
        sourceMessageSenderId: "alex",
        targetQueue: [],
      },
    } as never,
    true,
  );

  assertEquals(result, {
    targetId: "alex",
    targetQueue: [],
  });
});

Deno.test("resolveAgentResponseTarget routes to other mentioned agents", () => {
  const result = resolveAgentResponseTarget(
    "@Writer please take this next.",
    {
      id: "researcher",
      name: "Researcher",
    },
    {
      metadata: {
        sourceMessageSenderId: "alex",
        targetQueue: ["writer", "alex"],
      },
    } as never,
    true,
  );

  assertEquals(result, {
    targetId: "Writer",
    targetQueue: ["alex"],
  });
});

Deno.test("resolveAgentResponseTarget skips self mention and keeps the next valid mention", () => {
  const result = resolveAgentResponseTarget(
    "@Researcher looping back to @Writer for the draft.",
    {
      id: "researcher",
      name: "Researcher",
    },
    {
      metadata: {
        sourceMessageSenderId: "alex",
        targetQueue: [],
      },
    } as never,
    true,
  );

  assertEquals(result, {
    targetId: "Writer",
    targetQueue: ["alex"],
  });
});

Deno.test("resolveAgentResponseTarget preserves upstream return path on explicit handoff", () => {
  const result = resolveAgentResponseTarget(
    "@Assistant I finished my part.",
    {
      id: "copilotz",
      name: "Copilotz",
    },
    {
      metadata: {
        sourceMessageSenderId: "assistente-teste",
        targetQueue: ["user"],
      },
    } as never,
    true,
  );

  assertEquals(result, {
    targetId: "Assistant",
    targetQueue: ["assistente-teste", "user"],
  });
});

Deno.test("resolveAgentResponseTarget preserves queued targets from inbound routing", () => {
  const result = resolveAgentResponseTarget(
    "@Researcher I am still thinking.",
    {
      id: "researcher",
      name: "Researcher",
    },
    {
      metadata: {
        sourceMessageSenderId: "alex",
        targetQueue: ["writer", "alex"],
      },
    } as never,
    true,
  );

  assertEquals(result, {
    targetId: "writer",
    targetQueue: ["alex"],
  });
});

Deno.test("resolveAgentResponseTarget falls back to source sender when multi-agent is disabled", () => {
  const result = resolveAgentResponseTarget(
    "@Writer please take this next.",
    {
      id: "researcher",
      name: "Researcher",
    },
    {
      metadata: {
        sourceMessageSenderId: "alex",
        targetQueue: ["writer", "alex"],
      },
    } as never,
    false,
  );

  assertEquals(result, {
    targetId: "alex",
    targetQueue: [],
  });
});
