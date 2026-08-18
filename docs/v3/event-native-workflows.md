---
title: Copilotz v3 Event-Native Workflows
description: Graph-native LLM attempts and tool executions on canonical content, immutable events, and durable deliveries.
section: Internal Design
status: implementation
---

# Copilotz v3 Event-Native Workflows

Tool execution and LLM inference are durable domain workflows, not queue rows or
worker state. Their searchable control plane lives inline on graph nodes; their
potentially large bodies are canonical asset references; every lifecycle change
is one immutable semantic event with only the durable deliveries required by
matched plugin processors.

```text
thread ──has_llm_attempt──▶ llm_attempt ──has_child_attempt──▶ provider attempt
   │                               │
   └──has_tool_execution──▶ tool_execution
                                   │
message / participant ─────────────┘

typed transition
  └─ one transaction: workflow node + asset bodies/links + event + deliveries
                                                        │
                                                        └─ Oxian dispatch
```

The repositories are factory-created capabilities:

```ts
const attempts = createLlmAttemptRepository({
  coordinator,
  session,
  eventStore,
  assets,
});

const tools = createToolExecutionRepository({
  coordinator,
  session,
  eventStore,
  assets,
});
```

They return frozen plain records and closures. They expose no raw SQL or graph
mutation surface, and they do not import the CLI, server, filesystem, or a
runtime-specific worker API.

## Tool Executions

A `tool_execution` node keeps the tool identity, call ID, status, participant,
history visibility, safe error classification, timing, and compact metadata
inline. Its ordered content sequence uses stable roles:

- `tool.arguments` for invocation input;
- `tool.output` for the canonical result;
- `tool.projected_output` for a bounded/history-safe projection;
- `tool.error_detail` for restricted diagnostics; and
- ordinary attachment roles for additional files or media.

`create`, `update`, `complete`, `fail`, and `cancel` emit the corresponding
lowercase semantic event. A tool call is unique within its namespace and thread.
Terminal transitions cannot be reopened. Safe failure data stays queryable
inline while a potentially large or sensitive diagnostic body remains an asset.

When a visible tool result becomes a public participant message, message content
references the existing output asset. No result body is copied into the message
or event.

## LLM Attempts

An `llm_attempt` node represents either a logical request or one concrete
provider attempt. Provider fallback is explicit: concrete attempts link to their
logical parent through `has_child_attempt`, retain an attempt index, and record
provider/model, usage, cost, finish reason, timing, and safe failure fields
independently.

Content roles are:

- `llm.input` for ordered resolved input parts;
- `llm.tool_definitions` for the offered tool schema body;
- `body` for a final answer;
- `reasoning` for visibility-controlled reasoning;
- `llm.tool_calls` for structured calls;
- `provider.error_detail` for restricted provider diagnostics; and
- `provider.trace` for an optional restricted request/response trace.

`create`, `update`, `complete`, `fail`, and `cancel` are typed transitions.
`superseded` is an explicit terminal update used when newer causal input makes
an attempt obsolete. Cancellation can retain partial usage/cost and a safe
reason. Terminal completion, failure, cancellation, or supersession cannot
transition to another terminal outcome. A later metrics-only update may finalize
provider accounting without changing the terminal status.

A final answer promoted into an agent message reuses the answer asset. Tool-call
and reasoning bodies likewise remain references rather than copies in lifecycle
events.

## Identity, Recovery, and Content Ownership

- Every operation is namespace-scoped and its event carries the thread scope.
- Creation and list ordering use immutable event positions rather than clocks.
- A delivery-derived mutation identity gives processor retries stable domain and
  event deduplication keys.
- Terminal methods derive a deterministic fallback deduplication key, so a
  repeated completion/failure/cancellation observes the committed transition.
- A retry may prepare content again with fresh transient IDs. The repository
  resolves content idempotency keys to committed assets and rejects changed
  bytes under the same identity.
- Asset owner edges are synchronized after replacement. Obsolete trace or
  projection references stop pinning content, while currently referenced bodies
  remain live.
- Any invalid relationship, body conflict, serialization failure, event insert,
  or delivery insert rolls back the full aggregate mutation.

## Current Boundary

These repositories are now composed into the factory-created v3 engine context.
A delivery receives tenant-bound content, conversation, collection, attempt,
execution, and plugin-resource capabilities; a crash after child projections
reuses their delivery-derived identities on retry.

`createTextWorkflowPlugin()` is the first complete orchestration vertical over
those capabilities. It contributes five ordinary durable subscriptions:

1. addressed `message.created` events create logical LLM attempts;
2. logical attempts execute through registered LLM provider resources;
3. completed attempts project participant-labelled agent messages and tool
   executions;
4. tool executions run with a stable external idempotency key; and
5. terminal tool executions project tool messages addressed back to their
   producing agent.

An agent's explicit `runtimes.text` selects its provider/model; static
`llmOptions` remains the shorthand. Existing low-level provider factories are
wrapped by `defineLlmProviderResource()`, so the mature chat fallback and
recovery orchestrator remains reusable without making provider placement part of
the database model.

Parallel calls from one model response execute independently. Every result is a
labelled tool message. Only the last committed result for a fully present batch
creates the continuation attempt, so there is no mutable queue accumulator and
the model cannot resume on a partial batch. The continuation remains addressed
to the participant that produced the calls.

Provider text, reasoning, canonical tool-call drafts, and executing tool output
are published as ordered `text.delta`, `reasoning.delta`, `tool_call.delta`, and
`tool_output.delta` events. Tool output uses independent channels such as
`stdout`, `stderr`, `progress`, and `result`; terminal `tool_execution.*` events
settle the already-visible execution. These frames flow through the live event
hub and attachment outputs, carry their logical attempt or execution as stream
identity, and are never inserted into durable event storage. Final messages and
tool results remain asset-backed durable state.

An ordinary tool may return `WorkflowToolResult` when it produces one or more
files or media bodies. Its `output` remains the bounded result used for model
history and live `result` projection, while `attachments` are prepared and
committed as canonical content on the tool execution. The public tool-result
message reuses those refs. OpenAPI resources can create the same result
declaratively with `API.responseAssets`, mapping response fields for base64
data, media type, and optional filename.

Input attachments follow the inverse path. Transcript projection emits a compact
identity descriptor before each attachment, including both `assetId` and a
namespace-qualified `assetRef`. Provider-native image, audio, video, and file
parts are still supplied when supported. If a provider omits an unsupported file
body, the descriptor survives and allows an asset-aware tool to resolve or
import it without another upload.

Tests now prove user → agent → tool → same agent → public final output, one
external tool execution after recovery, explicit provider fallback children,
concurrent tools, and one post-batch continuation. The plugin is exported from
the root and `@copilotz/copilotz/{agents,llm,tools,events}` package surfaces.

The public `createCopilotz()` adapter and bundled core catalog still retain a
legacy composition path while downstream migration gates remain. The
event-native vertical already owns prompt/history hooks, API/MCP tool
generation, schema diagnostics and pipelines, usage integration, live frames,
and built-in provider packaging. Supersession policy and final downstream
cutover remain explicit parity work; the equivalent legacy workflow is deleted
only after those gates are green.
