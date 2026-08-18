import type { CopilotzProcessorContext } from "../engine/index.ts";
import {
  loadCollectionRecord,
  requireBoundCollection,
} from "../engine/collection-writes.ts";
import type { CopilotzEvent } from "../events/index.ts";
import {
  type CopilotzPlugin,
  definePlugin,
  defineProcessor,
  type Processor,
} from "../plugins/index.ts";
import type { CollectionRecord, ScopedEventCollection } from "../domain/index.ts";
import { usageCollection } from "./collection.ts";
import type { UsageCost, UsageOptions, UsageRecord } from "./types.ts";

const DEFAULT_PLUGIN_ID = "@copilotz/core-usage";
const DEFAULT_PLUGIN_VERSION = "3.0.0";

const TOKEN_METRICS = [
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "totalTokens",
] as const;

const COST_COMPONENTS = [
  "inputCostUsd",
  "outputCostUsd",
  "reasoningCostUsd",
  "cacheReadInputCostUsd",
  "cacheCreationInputCostUsd",
] as const;

export interface CreateUsageWorkflowPluginOptions extends UsageOptions {
  id?: string;
  version?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function tokenMetrics(value: unknown): Record<string, number> {
  const usage = record(value);
  const metrics: Record<string, number> = { calls: 1 };
  for (const key of TOKEN_METRICS) {
    const amount = finiteNumber(usage[key]);
    if (amount !== undefined) metrics[key] = amount;
  }
  return metrics;
}

function normalizedMetrics(value: unknown): Record<string, number> {
  const input = record(value);
  const metrics: Record<string, number> = {};
  for (const [key, candidate] of Object.entries(input)) {
    const amount = finiteNumber(candidate);
    if (amount === undefined) {
      throw new TypeError(`Usage metric '${key}' must be a finite number.`);
    }
    metrics[key] = amount;
  }
  return metrics;
}

function normalizedCost(value: unknown): UsageCost | null {
  if (value == null) return null;
  const input = record(value);
  const breakdown: Record<string, number> = {};
  for (const key of COST_COMPONENTS) {
    const amount = finiteNumber(input[key]);
    if (amount !== undefined) breakdown[key] = amount;
  }
  const nested = record(input.breakdown);
  for (const [key, candidate] of Object.entries(nested)) {
    const amount = finiteNumber(candidate);
    if (amount !== undefined) breakdown[key] = amount;
  }
  const total = finiteNumber(input.total) ?? finiteNumber(input.totalCostUsd) ??
    Object.values(breakdown).reduce((sum, amount) => sum + amount, 0);
  return {
    currency: optionalText(input.currency) ?? "USD",
    total,
    source: optionalText(input.source) ?? "unknown",
    ...(optionalText(input.pricingModelId)
      ? { pricingModelId: optionalText(input.pricingModelId) }
      : {}),
    ...(Object.keys(breakdown).length ? { breakdown } : {}),
  };
}

function usageCollectionFrom(
  context: CopilotzProcessorContext,
): ScopedEventCollection {
  const collection = context.collections.usage;
  if (!collection) {
    throw new Error(
      "The usage workflow requires the 'usage' collection resource.",
    );
  }
  return collection;
}

async function participantExternalId(
  context: CopilotzProcessorContext,
  participantId: string | undefined,
): Promise<string | null> {
  if (!participantId) return null;
  const participant = await loadCollectionRecord(
    context,
    "participant",
    participantId,
  );
  return optionalText(participant?.externalId) ?? participantId;
}

function workflowAttemptId(metadata: unknown): string | undefined {
  const workflow = record(record(metadata).copilotzWorkflow);
  return optionalText(workflow.llmAttemptId) ??
    optionalText(workflow.parentLlmAttemptId);
}

function isProviderAttemptMetadata(metadata: unknown): boolean {
  return record(record(metadata).copilotzWorkflow).kind === "provider_attempt";
}

function costFields(cost: UsageCost | null | undefined) {
  const breakdown = cost?.breakdown ?? {};
  return {
    inputCostUsd: finiteNumber(breakdown.inputCostUsd) ?? null,
    outputCostUsd: finiteNumber(breakdown.outputCostUsd) ?? null,
    reasoningCostUsd: finiteNumber(breakdown.reasoningCostUsd) ?? null,
    cacheReadInputCostUsd: finiteNumber(breakdown.cacheReadInputCostUsd) ??
      null,
    cacheCreationInputCostUsd:
      finiteNumber(breakdown.cacheCreationInputCostUsd) ?? null,
    totalCostUsd: cost?.total ?? null,
    pricingModelId: cost?.pricingModelId ?? null,
    pricingSource: cost?.source ?? null,
    pricingCurrency: cost?.currency ?? null,
  } as const;
}

function usageData(value: UsageRecord): Record<string, unknown> {
  const metrics = normalizedMetrics(value.metrics);
  const raw = record(value.raw);
  return {
    id: value.id,
    kind: value.kind,
    resource: value.resource,
    provider: value.provider ?? null,
    operation: value.operation ?? null,
    status: value.status ?? null,
    statusReason: value.statusReason ?? null,
    model: value.kind === "llm" ? value.resource : null,
    threadId: value.threadId,
    eventId: value.eventId ?? null,
    messageId: value.messageId ?? null,
    agentId: value.agentId ?? null,
    initiatedById: value.initiatedById ?? null,
    metrics,
    inputTokens: metrics.inputTokens ?? null,
    outputTokens: metrics.outputTokens ?? null,
    reasoningTokens: metrics.reasoningTokens ?? null,
    cacheReadInputTokens: metrics.cacheReadInputTokens ?? null,
    cacheCreationInputTokens: metrics.cacheCreationInputTokens ?? null,
    totalTokens: metrics.totalTokens ?? null,
    ...costFields(value.cost),
    source: optionalText(raw.source) ?? null,
    rawUsage: Object.keys(record(raw.rawUsage)).length
      ? structuredClone(record(raw.rawUsage))
      : null,
    stopSequence: optionalText(raw.stopSequence) ?? null,
    dedupeKey: value.dedupeKey ?? null,
    occurredAt: value.occurredAt ?? null,
    metricsFinalizedAt: optionalText(raw.metricsFinalizedAt) ?? null,
  };
}

async function applyUsageOptions(
  input: UsageRecord,
  source: unknown,
  options: CreateUsageWorkflowPluginOptions,
): Promise<UsageRecord | null> {
  const defaultCost = normalizedCost(input.cost);
  const cost = options.resolveCost
    ? normalizedCost(
      await options.resolveCost(
        { ...input, cost: defaultCost },
        {
          source,
          defaultResolve: () => Promise.resolve(defaultCost),
        },
      ),
    )
    : defaultCost;
  let resolved: UsageRecord = {
    ...structuredClone(input),
    metrics: normalizedMetrics(input.metrics),
    cost,
  };
  if (options.onRecord) {
    const transformed = await options.onRecord(
      Object.freeze(structuredClone(resolved)),
    );
    if (!transformed) return null;
    if (transformed.id !== input.id) {
      throw new TypeError("Usage onRecord cannot change the stable record id.");
    }
    resolved = {
      ...structuredClone(transformed),
      id: input.id,
      metrics: normalizedMetrics(transformed.metrics),
      cost: normalizedCost(transformed.cost),
    };
  }
  return Object.freeze(resolved);
}

async function persistUsage(
  input: UsageRecord,
  source: unknown,
  context: CopilotzProcessorContext,
  options: CreateUsageWorkflowPluginOptions,
): Promise<void> {
  const resolved = await applyUsageOptions(input, source, options);
  if (!resolved) return;
  await usageCollectionFrom(context).create(usageData(resolved), {
    operationKey: `record:${resolved.id}`,
  });
}

function llmUsageRecord(
  attempt: CollectionRecord,
  event: CopilotzEvent,
  initiatedById: string | null,
): UsageRecord {
  const usage = record(attempt.usage);
  const id = `usage:llm:${attempt.id}`;
  return {
    id,
    kind: "llm",
    resource: optionalText(attempt.model) ?? optionalText(attempt.provider) ??
      "unknown",
    provider: optionalText(attempt.provider) ?? null,
    operation: "chat",
    status: optionalText(attempt.status) ?? null,
    statusReason: optionalText(usage.statusReason) ??
      optionalText(record(attempt.safeError).code) ?? null,
    threadId: String(attempt.threadId),
    eventId: event.durable ? event.id : null,
    messageId: optionalText(attempt.messageId) ?? null,
    agentId: optionalText(attempt.agentId) ?? null,
    initiatedById,
    metrics: tokenMetrics(usage),
    cost: normalizedCost(attempt.cost),
    dedupeKey: attempt.id,
    occurredAt: optionalText(attempt.finishedAt) ??
      String(attempt.updatedAt),
    raw: {
      source: usage.source,
      rawUsage: usage.rawUsage,
      stopSequence: usage.stopSequence,
      metricsFinalizedAt: attempt.metricsFinalizedAt,
    },
  };
}

function toolUsageRecord(
  execution: CollectionRecord,
  event: CopilotzEvent,
  initiatedById: string | null,
): UsageRecord {
  const id = `usage:tool:${execution.id}`;
  const tool = record(execution.tool);
  const durationMs = finiteNumber(execution.durationMs);
  return {
    id,
    kind: "tool",
    resource: optionalText(tool.id) ?? optionalText(tool.name) ?? "unknown",
    operation: "tool.exec",
    status: optionalText(execution.status) ?? null,
    statusReason: optionalText(record(execution.safeError).code) ?? null,
    threadId: String(execution.threadId),
    eventId: event.durable ? event.id : null,
    messageId: optionalText(execution.messageId) ?? null,
    agentId: optionalText(execution.agentId) ?? null,
    initiatedById,
    metrics: {
      calls: 1,
      ...(durationMs === undefined ? {} : { durationMs }),
    },
    cost: null,
    dedupeKey: execution.id,
    occurredAt: optionalText(execution.finishedAt) ??
      String(execution.updatedAt),
    raw: { source: "copilotz" },
  };
}

function llmUsageProcessor(
  options: CreateUsageWorkflowPluginOptions,
): Processor<CopilotzProcessorContext> {
  return defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.core.record-llm-usage",
    on: [
      { eventType: "llm_attempt.updated" },
      { eventType: "llm_attempt.completed" },
      { eventType: "llm_attempt.failed" },
      { eventType: "llm_attempt.cancelled" },
    ],
    async handle(event, context) {
      if (!event.durable || !event.subject) return;
      const attempt = await requireBoundCollection(context, "llm_attempt").get(
        event.subject.id,
        context.namespace,
      );
      if (
        !attempt || !isProviderAttemptMetadata(attempt.metadata) ||
        !["completed", "failed", "cancelled", "superseded"].includes(
          String(attempt.status),
        )
      ) return;
      const initiatedById = await participantExternalId(
        context,
        optionalText(attempt.initiatorParticipantId),
      );
      await persistUsage(
        llmUsageRecord(attempt, event, initiatedById),
        attempt,
        context,
        options,
      );
    },
  });
}

function toolUsageProcessor(
  options: CreateUsageWorkflowPluginOptions,
): Processor<CopilotzProcessorContext> {
  return defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.core.record-tool-usage",
    on: [
      { eventType: "tool_execution.updated" },
      { eventType: "tool_execution.completed" },
      { eventType: "tool_execution.failed" },
      { eventType: "tool_execution.cancelled" },
    ],
    async handle(event, context) {
      if (!event.durable || !event.subject) return;
      const execution = await requireBoundCollection(context, "tool_execution")
        .get(event.subject.id, context.namespace);
      if (
        !execution || String(execution.status) === "pending" ||
        String(execution.status) === "running"
      ) return;
      const parentAttemptId = workflowAttemptId(execution.metadata);
      const parentAttempt = parentAttemptId
        ? await requireBoundCollection(context, "llm_attempt").get(
          parentAttemptId,
          context.namespace,
        )
        : null;
      const initiatedById = await participantExternalId(
        context,
        optionalText(parentAttempt?.initiatorParticipantId),
      );
      await persistUsage(
        toolUsageRecord(execution, event, initiatedById),
        execution,
        context,
        options,
      );
    },
  });
}

/** Creates durable accounting as ordinary collection and processor resources. */
export function createUsageWorkflowPlugin(
  options: CreateUsageWorkflowPluginOptions = {},
): CopilotzPlugin {
  const processors = options.enabled === false
    ? Object.freeze([]) as readonly Processor<CopilotzProcessorContext>[]
    : Object.freeze([
      llmUsageProcessor(options),
      toolUsageProcessor(options),
    ]);
  return definePlugin({
    manifest: {
      id: options.id ?? DEFAULT_PLUGIN_ID,
      version: options.version ?? DEFAULT_PLUGIN_VERSION,
      provides: {
        collections: [usageCollection.name],
        ...(processors.length
          ? { processors: processors.map((processor) => processor.id) }
          : {}),
      },
    },
    resources: {
      collections: [usageCollection],
      ...(processors.length ? { processors } : {}),
    },
  });
}
