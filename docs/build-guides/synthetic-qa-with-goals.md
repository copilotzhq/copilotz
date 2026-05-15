---
title: Run Synthetic QA with Goals
description: Use copilotz.goal to let a lead agent drive a target agent through a bounded journey.
section: Build Guides
order: 60
status: stable
---

# Run Synthetic QA with Goals

`copilotz.goal(...)` is useful when you want one agent-like sender to drive a
target agent toward an outcome.

This is ideal for synthetic QA.

## Example

```ts
const leadAgent = {
  id: "qa-direct-buyer",
  name: "QA Direct Buyer",
  role: "Simulated customer",
  instructions: `
You are Tiago. You want to buy one bus ticket.
Answer only with the text the customer would type.
When you receive a payment link or PIX code, thank the agent and end with:
[GOAL_COMPLETED]
  `.trim(),
  llmOptions: {
    provider: "gemini",
    model: "gemini-2.5-flash",
    apiKey: Deno.env.get("GEMINI_KEY"),
  },
};

const handle = await copilotz.goal({
  content: "Ola, quero comprar uma passagem de Sao Paulo para Peruibe.",
  sender: {
    id: "client-01",
    type: "user",
    name: "Tiago",
    usingAgent: leadAgent,
  },
  target: "sales-agent",
  thread: {
    externalId: "qa-client-01",
    participants: ["sales-agent"],
  },
  maxTurns: 30,
  stop: ({ lastMessage }) => {
    const text = lastMessage?.content ?? "";
    if (text.includes("[GOAL_COMPLETED]")) {
      return { stop: true, status: "completed", reason: "Goal completed" };
    }
    return false;
  },
  evaluate: ({ transcript }) => ({
    name: "payment-generated",
    status: transcript.some((message) => message.content.includes("pix"))
      ? "completed"
      : "failed",
  }),
});

for await (const event of handle.events) {
  console.log(event.type);
}

const result = await handle.done;
console.log(result.status, result.assessments);
```

## Important Privacy Boundary

The lead agent does not receive raw target tool results by default.

It receives the final target-facing text for the turn. Tool events still appear
in the outer goal event stream for audit and debugging.

## Related Pages

- [Goals](../runtime/goals.md)
- [Goal API](../reference/goal-api.md)
