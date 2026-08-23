import type { ScopedCollection } from "@copilotz/copilotz/collections";
import type { CopilotzProcessorContext } from "@copilotz/copilotz/engine";
import type { CopilotzEvent } from "@copilotz/copilotz/events";
import {
  type CopilotzPlugin,
  definePlugin,
  defineProcessor,
  type Processor,
} from "@copilotz/copilotz/plugins";
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
): ScopedCollection {
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
  const participant = await context.collections.participant.get({
    id: participantId,
  });
  return optionalText(participant?.externalId) ?? participantId;
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
  lifecycle: Record<string, unknown>,
  event: CopilotzEvent,
  initiatedById: string | null,
): UsageRecord {
  const input = record(lifecycle.input);
  const output = record(lifecycle.output);
  const error = record(lifecycle.error);
  const usage = record(output.usage);
  const actionRunId = optionalText(lifecycle.actionRunId) ??
    optionalText(input.id) ?? (event.durable ? event.id : event.correlationId);
  const id = `usage:llm:${actionRunId}`;
  return {
    id,
    kind: "llm",
    resource: optionalText(output.model) ?? optionalText(output.provider) ??
      "unknown",
    provider: optionalText(output.provider) ?? null,
    operation: "chat",
    status: optionalText(lifecycle.status) ?? null,
    statusReason: optionalText(usage.statusReason) ??
      optionalText(error.name) ?? null,
    threadId: String(input.threadId),
    eventId: event.durable ? event.id : null,
    messageId: optionalText(input.messageId) ?? null,
    agentId: optionalText(input.agentId) ?? null,
    initiatedById,
    metrics: tokenMetrics(usage),
    cost: normalizedCost(output.cost),
    dedupeKey: actionRunId,
    occurredAt: event.createdAt,
    raw: {
      source: usage.source,
      rawUsage: usage.rawUsage,
      stopSequence: usage.stopSequence,
      metricsFinalizedAt: output.metricsFinalizedAt,
    },
  };
}

function toolUsageRecord(
  lifecycle: Record<string, unknown>,
  event: CopilotzEvent,
  initiatedById: string | null,
): UsageRecord {
  const input = record(lifecycle.input);
  const output = record(lifecycle.output);
  const error = record(lifecycle.error);
  const actionRunId = optionalText(lifecycle.actionRunId) ??
    optionalText(input.id) ?? (event.durable ? event.id : event.correlationId);
  const id = `usage:tool:${actionRunId}`;
  const tool = record(input.tool);
  const durationMs = finiteNumber(output.durationMs);
  return {
    id,
    kind: "tool",
    resource: optionalText(tool.id) ?? optionalText(tool.name) ?? "unknown",
    operation: "tool.exec",
    status: optionalText(output.status) ?? optionalText(lifecycle.status) ??
      null,
    statusReason: optionalText(error.name) ?? null,
    threadId: String(input.threadId),
    eventId: event.durable ? event.id : null,
    messageId: optionalText(input.messageId) ?? null,
    agentId: optionalText(input.agentId) ?? null,
    initiatedById,
    metrics: {
      calls: 1,
      ...(durationMs === undefined ? {} : { durationMs }),
    },
    cost: null,
    dedupeKey: actionRunId,
    occurredAt: event.createdAt,
    raw: { source: "copilotz" },
  };
}

function llmUsageProcessor(
  options: CreateUsageWorkflowPluginOptions,
): Processor<CopilotzProcessorContext> {
  return defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.core.record-llm-usage",
    on: [
      { eventType: "copilotz.core.llm.generate.completed" },
      { eventType: "copilotz.core.llm.generate.failed" },
      { eventType: "copilotz.core.llm.generate.cancelled" },
      { eventType: "copilotz.core.llm.session.completed" },
      { eventType: "copilotz.core.llm.session.failed" },
      { eventType: "copilotz.core.llm.session.cancelled" },
    ],
    async handle(event, context) {
      if (!event.durable) return;
      const lifecycle = record(event.data);
      const input = record(lifecycle.input);
      const initiatedById = await participantExternalId(
        context,
        optionalText(input.initiatorParticipantId),
      );
      await persistUsage(
        llmUsageRecord(lifecycle, event, initiatedById),
        lifecycle,
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
      { eventType: "copilotz.core.tool.call.completed" },
      { eventType: "copilotz.core.tool.call.failed" },
      { eventType: "copilotz.core.tool.call.cancelled" },
    ],
    async handle(event, context) {
      if (!event.durable) return;
      const lifecycle = record(event.data);
      const input = record(lifecycle.input);
      const initiatedById = await participantExternalId(
        context,
        optionalText(input.initiatorParticipantId),
      );
      await persistUsage(
        toolUsageRecord(lifecycle, event, initiatedById),
        lifecycle,
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
    ? Object.freeze({})
    : Object.freeze({
      recordLlmUsage: llmUsageProcessor(options),
      recordToolUsage: toolUsageProcessor(options),
    });
  return definePlugin({
    id: options.id ?? DEFAULT_PLUGIN_ID,
    version: options.version ?? DEFAULT_PLUGIN_VERSION,
    collections: { usage: usageCollection },
    processors,
  });
}
