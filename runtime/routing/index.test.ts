import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import type { Agent, Thread } from "@/types/index.ts";
import {
  ASK_IN_THREAD_CONTROL,
  assertNoRoutingControlToolCollisions,
  buildRoutingControlInputSchema,
  buildRoutingControlToolDefinitions,
  HANDOFF_IN_THREAD_CONTROL,
  parseRoutingControlCall,
  resolveAllowedInThreadRoutingTargets,
  resolveInThreadRoutingTargets,
  selectRoutingControl,
} from "./index.ts";

function agent(
  id: string,
  options: { name?: string; allowedAgents?: string[] | null } = {},
): Agent {
  return {
    id,
    name: options.name ?? id,
    role: "assistant",
    allowedAgents: options.allowedAgents,
  };
}

Deno.test("resolveAllowedInThreadRoutingTargets returns canonical allowed agent ids in participant order", () => {
  const current = agent("lead", { allowedAgents: ["Reviewer"] });
  const reviewer = agent("reviewer", { name: "Reviewer" });
  const builder = agent("builder", { name: "Builder" });
  const thread = {
    id: "thread-1",
    name: "Team",
    participants: ["user-1", "Reviewer", "lead", "builder"],
  } as Thread;

  assertEquals(
    resolveAllowedInThreadRoutingTargets(
      current,
      thread,
      [current, builder, reviewer],
    ),
    [{ id: "reviewer", name: "Reviewer" }],
  );
});

Deno.test("resolveAllowedInThreadRoutingTargets applies strict allowedAgents semantics", () => {
  const reviewer = agent("reviewer");
  const thread = {
    id: "thread-1",
    name: "Team",
    participants: ["lead", "reviewer"],
  } as Thread;

  assertEquals(
    resolveAllowedInThreadRoutingTargets(
      agent("lead"),
      thread,
      [agent("lead"), reviewer],
    ).map((target) => target.id),
    ["reviewer"],
  );
  assertEquals(
    resolveAllowedInThreadRoutingTargets(
      agent("lead", { allowedAgents: null }),
      thread,
      [agent("lead"), reviewer],
    ),
    [],
  );
  assertEquals(
    resolveAllowedInThreadRoutingTargets(
      agent("lead", { allowedAgents: [] }),
      thread,
      [agent("lead"), reviewer],
    ),
    [],
  );
});

Deno.test("routing control definitions expose two atomic controls with dynamic targets", () => {
  const targets = {
    ask: [
      { id: "reviewer", name: "Reviewer" },
      { id: "builder", name: "Builder" },
    ],
    handoff: [
      { id: "reviewer", name: "Reviewer" },
      { id: "builder", name: "Builder" },
      { id: "user", name: "User" },
    ],
  };
  const definitions = buildRoutingControlToolDefinitions(targets);

  assertEquals(
    definitions.map((definition) => definition.function.name),
    [ASK_IN_THREAD_CONTROL, HANDOFF_IN_THREAD_CONTROL],
  );
  for (const definition of definitions) {
    assertStringIncludes(definition.function.inputTypes, "target");
    assertStringIncludes(definition.function.inputTypes, "message");
    assertStringIncludes(definition.function.inputTypes, '"reviewer"');
    assertStringIncludes(definition.function.inputTypes, '"builder"');
    assertStringIncludes(definition.function.description, "atomically");
  }
  assertStringIncludes(definitions[1].function.inputTypes, '"user"');
  assertEquals(
    buildRoutingControlToolDefinitions({ ask: [], handoff: [] }),
    [],
  );
});

Deno.test("resolveInThreadRoutingTargets exposes user only for handoff with one human", () => {
  const current = agent("lead");
  const reviewer = agent("reviewer");
  const thread = {
    id: "thread-1",
    name: "Team",
    participants: ["lead", "reviewer", "human-1"],
  } as Thread;

  assertEquals(
    resolveInThreadRoutingTargets(current, thread, [current, reviewer]),
    {
      ask: [{ id: "reviewer", name: "reviewer" }],
      handoff: [
        { id: "reviewer", name: "reviewer" },
        { id: "user", name: "User" },
      ],
    },
  );
});

Deno.test("buildRoutingControlInputSchema requires target and non-empty message", () => {
  assertEquals(buildRoutingControlInputSchema(["reviewer"]), {
    type: "object",
    additionalProperties: false,
    properties: {
      target: {
        type: "string",
        enum: ["reviewer"],
        description: "Exact id of an allowed agent participant in this thread.",
      },
      message: {
        type: "string",
        minLength: 1,
        description:
          "Complete non-empty message to deliver to the target agent.",
      },
    },
    required: ["target", "message"],
  });
});

Deno.test("parseRoutingControlCall validates and canonicalizes atomic control calls", () => {
  assertEquals(
    parseRoutingControlCall({
      id: "call-1",
      tool: { id: ASK_IN_THREAD_CONTROL },
      args: JSON.stringify({ target: "REVIEWER", message: " Check this. " }),
    }, {
      ask: [{ id: "reviewer", name: "Reviewer" }],
      handoff: [{ id: "builder", name: "Builder" }],
    }),
    {
      ok: true,
      intent: {
        action: "ask",
        targetId: "reviewer",
        message: "Check this.",
        source: "model_control",
        controlCallId: "call-1",
      },
    },
  );

  assertEquals(
    parseRoutingControlCall({
      tool: { id: HANDOFF_IN_THREAD_CONTROL },
      args: { target: "builder", message: "Implement this." },
    }, {
      ask: [{ id: "reviewer", name: "Reviewer" }],
      handoff: [{ id: "builder", name: "Builder" }],
    }),
    {
      ok: true,
      intent: {
        action: "handoff",
        targetId: "builder",
        message: "Implement this.",
        source: "model_control",
      },
    },
  );
});

Deno.test("parseRoutingControlCall rejects missing messages, invalid targets, and extra arguments", () => {
  assertEquals(
    parseRoutingControlCall({
      tool: { id: ASK_IN_THREAD_CONTROL },
      args: { target: "reviewer", message: "  " },
    }, {
      ask: [{ id: "reviewer", name: "Reviewer" }],
      handoff: [{ id: "reviewer", name: "Reviewer" }],
    }).ok,
    false,
  );
  assertEquals(
    parseRoutingControlCall({
      tool: { id: ASK_IN_THREAD_CONTROL },
      args: { target: "outside", message: "Hello" },
    }, {
      ask: [{ id: "reviewer", name: "Reviewer" }],
      handoff: [{ id: "reviewer", name: "Reviewer" }],
    }),
    {
      ok: false,
      code: "invalid_target",
      message: "ask_in_thread target must be one of: reviewer.",
    },
  );
  assertEquals(
    parseRoutingControlCall({
      tool: { id: HANDOFF_IN_THREAD_CONTROL },
      args: { target: "reviewer", message: "Hello", extra: true },
    }, {
      ask: [{ id: "reviewer", name: "Reviewer" }],
      handoff: [{ id: "reviewer", name: "Reviewer" }],
    }).ok,
    false,
  );
});

Deno.test("selectRoutingControl keeps controls exclusive from executable tools", () => {
  const targets = {
    ask: [{ id: "reviewer", name: "Reviewer" }],
    handoff: [{ id: "reviewer", name: "Reviewer" }],
  };
  const control = {
    id: "route-1",
    tool: { id: ASK_IN_THREAD_CONTROL },
    args: JSON.stringify({ target: "reviewer", message: "Review this." }),
  };

  assertEquals(selectRoutingControl([control], targets), {
    kind: "routing",
    intent: {
      action: "ask",
      targetId: "reviewer",
      message: "Review this.",
      source: "model_control",
      controlCallId: "route-1",
    },
  });
  assertEquals(
    selectRoutingControl([
      control,
      { id: "tool-1", tool: { id: "search" }, args: "{}" },
    ], targets).kind,
    "invalid",
  );
  assertEquals(
    selectRoutingControl([control, { ...control, id: "route-2" }], targets)
      .kind,
    "invalid",
  );
});

Deno.test("assertNoRoutingControlToolCollisions rejects executable tools using reserved names", () => {
  assertNoRoutingControlToolCollisions([{ key: "ordinary_tool" }]);
  assertThrows(
    () =>
      assertNoRoutingControlToolCollisions([{
        key: HANDOFF_IN_THREAD_CONTROL,
      }]),
    Error,
    "reserved for Copilotz in-thread routing",
  );
});
