import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  assertAgentLLMConfig,
  resolveAgentResponseTarget,
  shouldEmitAgentMessage,
} from "./index.ts";

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
    targetId: "alex",
    targetQueue: ["writer", "alex"],
  });
});

Deno.test("resolveAgentResponseTarget returns delegated specialists to the delegating agent before the upstream queue", () => {
  const result = resolveAgentResponseTarget(
    [],
    {
      id: "reviewer",
      name: "reviewer",
    },
    {
      metadata: {
        sourceMessageSenderId: "generalist-genius",
        targetQueue: ["User"],
      },
    } as never,
    true,
  );

  assertEquals(result, {
    targetId: "generalist-genius",
    targetQueue: ["User"],
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

Deno.test("assertAgentLLMConfig throws a helpful error when provider/model are missing", () => {
  assertThrows(
    () =>
      assertAgentLLMConfig(
        {
          id: "copilotz",
          name: "copilotz",
        },
        {},
      ),
    Error,
    'Agent "copilotz" is missing required llmOptions (provider, model).',
  );
});

Deno.test("assertAgentLLMConfig accepts a complete provider/model pair", () => {
  assertAgentLLMConfig(
    {
      id: "copilotz",
      name: "copilotz",
    },
    {
      provider: "openai",
      model: "gpt-5-mini",
    },
  );
});
