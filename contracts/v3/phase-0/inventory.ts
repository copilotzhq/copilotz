/**
 * Phase 0 baseline inventory for the plugin-first event-sourced refactor.
 * Keep this file honest: if production behavior changes, update the inventory
 * in the same commit. Do not delete a listed path until its preserving tests
 * still pass through the replacement.
 */

export const PHASE_0_BASELINE = Object.freeze({
  commit: "2b2bb77cac780dfecebada11691643795a90adaf",
  version: "0.60.18",
  recordedAt: "2026-08-17",
  suite: Object.freeze({
    command: "deno task test",
    passed: 571,
    failed: 0,
    ignored: 3,
    ignoredNames: Object.freeze([
      "A28 v1 upgrade executes against PostgreSQL",
      "S3 asset body store interoperates with MinIO",
      "PostgreSQL keeps the four-table baseline and atomic event/delivery semantics",
    ]),
    elapsed: "3m12s",
  }),
});

/** Current package resource kinds. Phase 4 replaces this closed set. */
export const BASELINE_RESOURCE_TYPES = Object.freeze(
  [
    "agents",
    "tools",
    "processors",
    "collections",
    "providers",
    "channels",
    "skills",
    "context",
    "memoryKinds",
    "apis",
    "mcpServers",
    "features",
    "storage",
  ] as const,
);

/** Target closed vocabulary from the handoff. Not the baseline. */
export const TARGET_RESOURCE_TYPES = Object.freeze(
  [
    "agents",
    "collections",
    "processors",
    "context",
    "llm",
    "embedding",
    "tools",
    "skills",
    "features",
    "storage",
    "mcp",
    "api",
  ] as const,
);

/**
 * Phase 4 registry: target vocabulary plus deferred `channels` and
 * `memoryKinds` until Phases 9 and 10.
 */
export const PHASE_4_RESOURCE_TYPES = Object.freeze(
  [
    ...TARGET_RESOURCE_TYPES,
    "channels",
    "memoryKinds",
  ] as const,
);

export const PUBLIC_ROOT_FACTORIES = Object.freeze(
  [
    "createCopilotz",
    "createCopilotzGateway",
    "createCopilotzWorker",
    "definePlugin",
    "defineProcessor",
    "defineCollection",
    "createAttachmentRuntime",
    "createContentPreparer",
    "createConversationRepository",
    "createEventStore",
    "createAgentCapabilityResolver",
  ] as const,
);

export const RUNTIME_NEUTRAL_CHECKS = Object.freeze(
  [
    "contracts/v3/architecture.contract.test.ts",
    "contracts/v3/runtime-portability.contract.test.ts",
    "contracts/v3/public-surface.contract.test.ts",
    "contracts/runtime/runtime-neutral-smoke.ts",
    "scripts/check-forbidden-symbols.ts",
    "scripts/check-package-surface.ts",
  ] as const,
);

/**
 * Production modules that INSERT/UPDATE/DELETE nodes or edges directly.
 * Phase 3–11 delete these write paths only after equivalent tests pass.
 */
export const NATIVE_GRAPH_MUTATION_MODULES = Object.freeze(
  [
    "runtime/domain/conversation.ts",
    "runtime/domain/llm-attempts.ts",
    "runtime/domain/tool-executions.ts",
    "runtime/domain/relations.ts",
    "runtime/domain/collections.ts",
    "runtime/domain/workflow-support.ts",
    "runtime/content/database-repository.ts",
  ] as const,
);

/** Event-table writers. Not domain graph writers. */
export const EVENT_TABLE_MUTATION_MODULES = Object.freeze(
  [
    "runtime/events/store.ts",
  ] as const,
);

/**
 * Durable Copilotz event names emitted by production code today.
 * Collection commands also emit `${collection}.${command}` (see collections.ts).
 */
export const DURABLE_EVENT_NAMES = Object.freeze(
  [
    "participant.created",
    "participant.updated",
    "thread.created",
    "thread.updated",
    "thread.deleted",
    "message.created",
    "message.revised",
    "llm_attempt.created",
    "llm_attempt.updated",
    "llm_attempt.completed",
    "llm_attempt.failed",
    "llm_attempt.cancelled",
    "tool_execution.created",
    "tool_execution.updated",
    "tool_execution.completed",
    "tool_execution.failed",
    "tool_execution.cancelled",
    "relation.created",
    "relation.deleted",
    "asset.created",
    "asset.deleted",
    "document.created",
    "document.processing",
    "document.failed",
    "document.deleted",
  ] as const,
);

/** Collection kernel templates. Named commands do not emit `*.updated`. */
export const COLLECTION_EVENT_TEMPLATES = Object.freeze(
  [
    "${name}.created",
    "${name}.updated",
    "${name}.deleted",
    "${name}.${command}",
  ] as const,
);

/**
 * First-party collections that use the generic kernel today.
 * Native conversation/attempt/execution/stream do not.
 */
export const GENERIC_COLLECTION_NAMES = Object.freeze(
  [
    "scheduled_job",
    "usage",
    "memory_space",
    "memory_space_access",
    "long_term_memory",
    "memory_record",
    "document",
    "chunk",
  ] as const,
);

export const EPHEMERAL_EVENT_NAMES = Object.freeze(
  [
    "text.delta",
    "reasoning.delta",
    "audio.delta",
    "tool_call.delta",
    "tool_output.delta",
  ] as const,
);

export const EPHEMERAL_EVENT_PRODUCERS = Object.freeze(
  [
    "runtime/events/types.ts",
    "runtime/engine/context.ts",
    "runtime/engine/database-scope.ts",
    "runtime/attachments/attachment.ts",
    "runtime/tools/executor.ts",
  ] as const,
);

/** Attachment/channel live outputs. Not event-table rows. */
export const ATTACHMENT_OUTPUT_TYPES = Object.freeze(
  [
    "stream.output",
    "audio.input",
  ] as const,
);

export const CONVERSATION_WRITE_METHODS = Object.freeze(
  [
    "createParticipant",
    "updateParticipant",
    "createThread",
    "addThreadParticipant",
    "updateThread",
    "deleteThread",
    "createMessage",
    "reviseMessage",
    "deleteThreadMessages",
  ] as const,
);

export const CONVERSATION_READ_METHODS = Object.freeze(
  [
    "getParticipant",
    "getParticipantByExternalId",
    "listParticipants",
    "getThread",
    "getThreadByExternalId",
    "listThreads",
    "getMessage",
    "listMessages",
    "listMessageRevisions",
  ] as const,
);

export const MESSAGE_LIST_OPTIONS = Object.freeze(
  [
    "after",
    "before",
    "limit",
    "order",
    "view",
  ] as const,
);

export const LLM_ATTEMPT_WRITE_METHODS = Object.freeze(
  [
    "create",
    "update",
    "complete",
    "fail",
    "cancel",
  ] as const,
);

export const TOOL_EXECUTION_WRITE_METHODS = Object.freeze(
  [
    "create",
    "update",
    "complete",
    "fail",
    "cancel",
  ] as const,
);

/**
 * There is no stream collection in 0.60.18. Progress is ephemeral deltas plus
 * attachment `stream.output`. Phase 8 introduces stream as a core collection.
 */
export const STREAM_COLLECTION_EXISTS = false;

export const TEST_INJECTION_POINTS = Object.freeze(
  [
    {
      seam: "LlmResource.generate",
      files: [
        "runtime/llm/provider-resource.ts",
        "plugins/core/text.test.ts",
        "plugins/core/ask.test.ts",
      ],
      replacement: "llm resource",
    },
    {
      seam: "core plugin llm adapters",
      files: [
        "plugins/core/resources/llm/index.ts",
        "plugins/core/plugin.ts",
      ],
      replacement: "llm resource",
    },
    {
      seam: "defineLlmProviderResource",
      files: [
        "runtime/llm/provider-resource.ts",
        "plugins/core/resources/llm/index.ts",
        "plugins/core/text.test.ts",
        "runtime/attachments/context.test.ts",
        "contracts/v3/downstream-embedding.contract.test.ts",
      ],
      replacement: "llm resource",
    },
  ] as const,
);

export const FEATURES_VS_API = Object.freeze({
  features: Object.freeze({
    contract: "runtime/features/types.ts",
    shape: "{ id, actions: Record<string, FeatureAction> }",
    direction: "inbound invoke; HTTP /features/... is an optional projection",
    contextToday:
      "FeatureContext is processor primitives (collections, transaction, content, resources, features) plus namespace; no application",
    examples: Object.freeze([
      "runtime/admin/plugin.ts (admin projections)",
      "clients/compass identity OAuth and session actions",
      "clients/compass WhatsApp config/exchange/webhook",
    ]),
  }),
  api: Object.freeze({
    contract: "runtime/resources/types.ts",
    shape: "OpenAPI-backed outbound HTTP tool",
    direction: "agent-callable, capability-granted",
    examples: Object.freeze([
      "runtime/tools/catalog.ts",
      "runtime/adapters/server-tool-catalog.ts",
    ]),
  }),
});

export const PACKAGES_STREAM_CONTRACT = Object.freeze({
  repo: "lib/packages/copilotz-chat-adapter",
  nativeEventTypes: Object.freeze([
    "text.delta",
    "reasoning.delta",
    "tool_call.delta",
    "tool_output.delta",
    "tool_execution.created",
    "tool_execution.completed",
    "tool_execution.failed",
    "tool_execution.cancelled",
    "message.created",
  ]),
  legacyEventTypes: Object.freeze([
    "TOKEN",
    "TOOL_CALL_DELTA",
    "TOOL_OUTPUT_DELTA",
    "NEW_MESSAGE",
    "LLM_RESULT",
  ]),
  resume: Object.freeze({
    baseline: "HTTP query afterPosition; SSE frames have no id: field",
    v1Projector: "server/v1-sse.ts maps native deltas to uppercase names",
    target: "SSE event position as resume ID plus per-stream offsets",
  }),
});

/** Named preserving tests. No listed subsystem may be deleted without these. */
export const PRESERVING_TESTS = Object.freeze(
  {
    collections:
      "runtime/domain/collections.test.ts, runtime/domain/collection-content.test.ts",
    conversation: "runtime/domain/conversation.test.ts",
    llmAttempts: "runtime/domain/llm-attempts.test.ts",
    toolExecutions: "runtime/domain/tool-executions.test.ts",
    relations: "runtime/domain/relations.test.ts",
    textWorkflow: "plugins/core/text.test.ts",
    ask: "plugins/core/ask.test.ts",
    pipelines:
      "runtime/tools/jq-pipeline.test.ts, runtime/tools/pipeline.test.ts",
    tools: "runtime/tools/executor.test.ts, runtime/tools/core-plugin.test.ts",
    context: "runtime/context/context.test.ts",
    skills: "runtime/skills/plugin.test.ts",
    memory:
      "runtime/memory/plugin.test.ts, runtime/memory/consolidation.test.ts",
    knowledge: "runtime/knowledge/knowledge.test.ts",
    schedules: "runtime/schedules/schedules.test.ts",
    goals: "plugins/goals/goal.test.ts",
    usage: "plugins/usage/plugin.test.ts",
    channels:
      "runtime/channels/runtime.test.ts, runtime/channels/whatsapp/channel.test.ts, runtime/channels/telegram/channel.test.ts, runtime/channels/discord/channel.test.ts, runtime/channels/zendesk/channel.test.ts",
    attachments:
      "runtime/attachments/attachment.test.ts, runtime/attachments/context.test.ts",
    providers:
      "plugins/core/plugin.test.ts, runtime/llm/fallback.test.ts, plugins/core/resources/llm/openai/adapter.test.ts",
    events:
      "runtime/events/event-store.test.ts, runtime/events/coordinator.test.ts, runtime/events/hub.test.ts",
    sse:
      "server/fetch.test.ts, server/v1-sse.test.ts, server/event-native.test.ts",
    publicSurface: "contracts/v3/public-surface.contract.test.ts",
    phase0Fixture: "contracts/v3/phase-0/conversation-fixture.test.ts",
  } as const,
);
