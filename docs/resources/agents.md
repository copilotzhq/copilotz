---
title: Agents
description: Resource shape for agent configuration.
section: Resources
order: 20
status: stable
---

# Agents

Agent resources define model-backed workers.

## Code Shape

```ts
export default {
  id: "support",
  name: "Support",
  role: "customer support assistant",
  instructions: "Help customers solve support issues.",
  llmOptions: {
    provider: "openai",
    model: "gpt-4o-mini",
  },
  allowedTools: ["search_knowledge"],
};
```

## Dynamic Instructions

Use `instructionsResolver` when an agent needs to choose its **local**
instructions for a specific LLM input while retaining the same agent identity,
tools, and routing behavior.

```ts
const variants = {
  A: "Use the control booking guidance.",
  B: "Use the candidate booking guidance.",
} as const;

export default {
  id: "booking",
  name: "Booking",
  role: "booking assistant",
  instructions: variants.A,
  instructionsResolver: ({ baseInstructions, userMetadata }) => {
    const privateMetadata = userMetadata?._private as {
      ab_tests?: { booking_copy_v1?: { variant?: string } };
    } | undefined;
    const variant = privateMetadata?.ab_tests?.booking_copy_v1?.variant;
    return variant === "B" ? variants.B : baseInstructions;
  },
};
```

The resolver may return a string to replace the local instructions, `null` to
omit them, or `undefined` to keep `instructions`. It may be async. Its result is
used only while composing that LLM input; it cannot change routing, tools, or
the registered agent object.

Resolver errors are propagated and prevent the provider call. Return `undefined`
only for an intentional fallback to the static instructions.

The resolver runs once for each LLM input built for that agent. A human turn can
produce additional inputs after tool calls or background work, so use
`sourceEvent` when a variation must apply only to a particular event type.

## File Shape

A project can keep agents under `resources/agents/<agent-name>/`.

Common files:

- `config.ts`
- `instructions.md`

## Public Surface

Agents are consumed by:

- `createCopilotz(...)`
- `run(...)` routing through `target`
- `goal(...)` lead and target resolution
- app endpoints that list public agents

## Related Pages

- [Agents](../core-concepts/agents.md)
- [createCopilotz](../reference/create-copilotz.md)
