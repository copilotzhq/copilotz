import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { resolveAgentResponseTarget, shouldEmitAgentMessage } from "./index.ts";

Deno.test("resolveAgentResponseTarget ignores self routes and falls back to sender", () => {
  const result = resolveAgentResponseTarget(
    ["researcher"],
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

Deno.test("resolveAgentResponseTarget routes to explicit route targets", () => {
  const result = resolveAgentResponseTarget(
    ["Writer"],
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

Deno.test("resolveAgentResponseTarget skips self route and keeps the next valid target", () => {
  const result = resolveAgentResponseTarget(
    ["Researcher", "Writer"],
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
    ["Assistant"],
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
    ["Researcher"],
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
    ["Writer"],
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

Deno.test("shouldEmitAgentMessage treats route-only replies as actionable", () => {
  assertEquals(
    shouldEmitAgentMessage("", undefined, ["writer"], []),
    true,
  );
  assertEquals(
    shouldEmitAgentMessage(
      "",
      undefined,
      [],
      ["writer"],
    ),
    true,
  );
  assertEquals(
    shouldEmitAgentMessage("", undefined, [], []),
    false,
  );
});
