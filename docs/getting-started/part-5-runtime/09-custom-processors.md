---
title: "Ch 9: Custom Processors"
description: "Middleware-like hooks over every event in the agent lifecycle."
section: Getting Started
order: 90
status: stable
---

# Chapter 9: Custom Processors

> **Part 5 — Controlling the Runtime**

## The pain

Your agent can call tools. Some of those tools are powerful — they can write files, execute shell commands, call external APIs, delete records. The LLM is generally good at deciding when to use them, but "generally good" is not "always safe."

You want a review step. Before the `delete_record` tool actually runs, you want to check: is this a legitimate deletion, or did the LLM hallucinate a reason? Before `run_command` executes a shell command, you want to validate it isn't destructive. You need middleware — a way to intercept what the agent is about to do and make a decision.

There's no hook in the LLM API for this. The standard tool-calling flow goes from "LLM produces tool call" to "tool executes" with nothing in between.

## The solution

Copilotz processes every agent action through an **event processor chain**. When the LLM decides to call a tool, a `TOOL_CALL` event is created and passed through registered processors in priority order. You can insert your own processor anywhere in that chain — inspect the event, block it, modify it, or let it through.

This is middleware for agent actions.

Create `resources/processors/safety-guard/index.ts`:

```typescript
export default {
  eventType: "TOOL_CALL",
  id: "safety-guard",
  priority: 100,  // Higher number = runs before built-in processors

  shouldProcess: (event) => {
    // Only intercept tool calls — let everything else through
    return event.type === "TOOL_CALL";
  },

  process: async (event, deps) => {
    const toolCall = event.payload?.toolCall;
    const toolKey = toolCall?.tool?.key ?? toolCall?.tool?.id;

    // Block destructive shell commands
    if (toolKey === "run_command") {
      const command = toolCall?.args?.command ?? "";
      const blocked = ["rm -rf", "drop table", "format", "mkfs"].some(
        (pattern) => command.toLowerCase().includes(pattern)
      );

      if (blocked) {
        console.warn(`[safety-guard] Blocked destructive command: ${command}`);
        // Swallow the event — the tool will not execute
        return { producedEvents: [] };
      }
    }

    // Log all tool calls for auditing
    console.log(`[audit] Tool called: ${toolKey}`, {
      threadId: event.threadId,
      args: toolCall?.args,
      timestamp: new Date().toISOString(),
    });

    // Return undefined to pass through — let the built-in processor handle it
    return undefined;
  },
};
```

That's it. Place this file in `resources/processors/safety-guard/` and Copilotz auto-loads it (assuming `resources.path` is configured). The safety guard runs before every tool call.

## How processors work

A processor is an object with three fields:

```typescript
{
  eventType: string;     // Which event type to handle
  id?: string;           // Optional: identifier for logging/debugging
  priority?: number;     // Higher = runs earlier (default: 0)

  shouldProcess: (event, deps) => boolean | Promise<boolean>;
  process: (event, deps) => ProcessorResult | Promise<ProcessorResult>;
}
```

**Return values control the chain:**

| What you return | What happens |
|----------------|-------------|
| `undefined` / `void` | **Pass** — this processor passes; the next processor runs |
| `{ producedEvents: [event1, event2] }` | **Claim** — enqueue these events; remaining processors are skipped |
| `{ producedEvents: [] }` | **Swallow** — claim without producing anything; the original event is consumed |

The first processor to return `producedEvents` wins. Everything after it is skipped for this event.

## The `deps` object

Your processor receives `deps` with useful references:

```typescript
type ProcessorDeps = {
  db: CopilotzDb;           // Database access — read/write any table
  thread: Thread;           // Current thread metadata
  context: ChatContext;     // Full request context
  emitToStream: (event) => void;  // Emit to real-time stream (for TOKEN, ASSET_CREATED, etc.)
};
```

Use `deps.db` to query the database, `deps.thread` to inspect thread metadata, and `deps.emitToStream` to push ephemeral events to the client stream.

## A more complete example: approval workflow

```typescript
// resources/processors/require-approval/index.ts
export default {
  eventType: "TOOL_CALL",
  id: "require-approval",
  priority: 90,

  shouldProcess: (event) => event.type === "TOOL_CALL",

  process: async (event, deps) => {
    const toolCall = event.payload?.toolCall;
    const toolKey = toolCall?.tool?.key ?? toolCall?.tool?.id;

    const HIGH_RISK_TOOLS = ["delete_record", "send_email", "create_payment"];

    if (!HIGH_RISK_TOOLS.includes(toolKey)) {
      return undefined; // Not a high-risk tool — pass through
    }

    // Check if this action is pre-approved in thread metadata
    const approved = deps.thread.metadata?.approvedActions ?? [];
    const actionId = `${toolKey}:${JSON.stringify(toolCall?.args)}`;

    if (approved.includes(actionId)) {
      return undefined; // Pre-approved — let it execute
    }

    // Emit a stream event requesting approval
    deps.emitToStream({
      type: "APPROVAL_REQUIRED",
      payload: {
        toolKey,
        args: toolCall?.args,
        actionId,
        message: `Agent wants to call ${toolKey}. Approve?`,
      },
    });

    // Swallow the tool call — it won't execute until approved
    return { producedEvents: [] };
  },
};
```

Your frontend listens for `APPROVAL_REQUIRED` events and shows the user a confirmation dialog. When approved, it sends a new message with the approval token, which a second processor picks up and re-enqueues the original tool call.

## Processors as resource files

Processors follow the same resource file convention. Create them in `resources/processors/{name}/index.ts` and they're auto-loaded.

You can also register them inline:

```typescript
const copilotz = await createCopilotz({
  processors: [safetyGuardProcessor, requireApprovalProcessor],
  // ...
});
```

## What this unlocks

- Middleware-like control over every step of agent execution
- Safety rails that can block or modify any action before it executes
- Audit logging at the framework level — nothing slips through
- Approval workflows for high-stakes operations
- Completely custom event handling without modifying tool code

## What's next

We've now seen `TOOL_CALL` processors in action. But there are many more event types — messages, LLM calls, results, streaming tokens. Understanding the full picture of how events flow through Copilotz unlocks the ability to hook into *any* part of the lifecycle.

→ **[Chapter 10: The Event System](./10-event-system.md)**
