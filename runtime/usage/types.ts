/**
 * Unified, source-agnostic usage accounting types.
 *
 * A single `usage` ledger record represents any cost-incurring operation —
 * LLM calls, tool executions, and (in the future) assets, RAG, embeddings,
 * speech, etc. Metering (how much happened) is owned by the framework; pricing
 * (what it costs) is resolved via a pluggable `resolveCost` hook so each
 * deployment can price non-LLM resources or override the built-in LLM pricing.
 */

/**
 * Resource family that produced a usage record. Open-ended on purpose: the set
 * of cost-incurring resources grows over time, so this is a string union with
 * an open escape rather than a closed enum.
 */
export type UsageKind =
  | "llm"
  | "tool"
  | "asset"
  | "rag"
  | "embedding"
  | (string & Record<never, never>);

/**
 * Normalized, source-agnostic cost block. `breakdown` carries kind-specific
 * components (e.g. input/output/reasoning for LLMs) while `total` is the single
 * value the dashboards aggregate.
 */
export interface UsageCost {
  /** ISO 4217 currency code, e.g. "USD". */
  currency: string;
  /** Total cost in `currency`. */
  total: number;
  /** Per-component costs (e.g. inputCostUsd, outputCostUsd, ...). */
  breakdown?: Record<string, number>;
  /** Where the price came from: "openrouter" | "custom" | "vendor" | ... */
  source: string;
  /** Optional pricing model identifier used for the estimate. */
  pricingModelId?: string;
}

/**
 * A metered usage event before persistence. `metrics` is a flat map of numeric
 * quantities (tokens, calls, durationMs, bytes, ...). It is a map — not an
 * array of `{name,value}` — so aggregation stays a direct, indexable JSONB
 * path (`data->>'inputTokens'`) instead of a per-row array unnest. Per-metric
 * presentation metadata (unit/label) lives in {@link METRIC_DESCRIPTORS}, since
 * it is identical across rows and does not belong in every record.
 */
export interface UsageEvent {
  /** Resource family. */
  kind: UsageKind;
  /** Specific resource: model id for LLM, tool key for tools, etc. */
  resource: string;
  /** Vendor/provider name when applicable (e.g. "openai", "anthropic"). */
  provider?: string | null;
  /** Operation performed, e.g. "chat", "embed", "tool.exec". */
  operation?: string | null;
  /** Terminal status of the operation. */
  status?: string | null;
  /** Optional machine-readable status reason. */
  statusReason?: string | null;

  // Scope / attribution (stored flat for cheap grouping + filtering).
  threadId: string;
  eventId?: string | null;
  messageId?: string | null;
  /** Generating participant (the agent that performed the operation). */
  agentId?: string | null;
  /** Initiating participant external id (resolved from the run sender). */
  initiatedById?: string | null;
  /** Raw run sender, used to resolve `initiatedById` and attribution edges. */
  runSender?: Record<string, unknown> | null;

  /** Flat numeric metering quantities. */
  metrics: Record<string, number>;
  /** Optional pre-computed cost (e.g. LLM cost already estimated upstream). */
  cost?: UsageCost | null;

  /** Idempotency key (attemptId, toolExecutionId, ...) to dedupe retries. */
  dedupeKey?: string | null;
  /** When the metered operation occurred. Defaults to now at write time. */
  occurredAt?: string | null;
  /** Optional opaque vendor payload for debugging/auditing. */
  raw?: unknown;
}

/** Presentation metadata for a metric, shared across all records. */
export interface MetricDescriptor {
  unit: string;
  label: string;
  /** Restrict the descriptor to a kind when the same name differs by family. */
  kind?: UsageKind;
}

/**
 * Static registry describing known metrics for display. Storing this here keeps
 * ledger rows tiny (numbers only) while still letting UIs render units/labels.
 */
export const METRIC_DESCRIPTORS: Record<string, MetricDescriptor> = {
  inputTokens: { unit: "tokens", label: "Input tokens", kind: "llm" },
  outputTokens: { unit: "tokens", label: "Output tokens", kind: "llm" },
  reasoningTokens: { unit: "tokens", label: "Reasoning tokens", kind: "llm" },
  cacheReadInputTokens: {
    unit: "tokens",
    label: "Cache read input tokens",
    kind: "llm",
  },
  cacheCreationInputTokens: {
    unit: "tokens",
    label: "Cache creation input tokens",
    kind: "llm",
  },
  totalTokens: { unit: "tokens", label: "Total tokens", kind: "llm" },
  calls: { unit: "calls", label: "Calls" },
  durationMs: { unit: "ms", label: "Duration" },
  bytes: { unit: "bytes", label: "Payload size" },
};

/**
 * Context handed to a {@link UsageResolveCost} hook. `source` carries the
 * originating payload (the LLM usage attempt, tool execution result, ...) so
 * callers can price based on it; `defaultResolve` returns the framework's
 * built-in estimate (OpenRouter LLM pricing) so user code can compose with it.
 */
export interface UsageResolveCostContext {
  source: unknown;
  defaultResolve: () => Promise<UsageCost | null>;
}

/** Resolve cost for a metered event. Return null to leave it uncosted. */
export type UsageResolveCost = (
  event: UsageEvent,
  ctx: UsageResolveCostContext,
) => UsageCost | null | Promise<UsageCost | null>;

/**
 * A fully resolved usage record about to be (or already) persisted. This is the
 * event plus its resolved cost and the assigned node id.
 */
export interface UsageRecord extends UsageEvent {
  id?: string;
  cost?: UsageCost | null;
}

/** Veto or transform a record before persistence. Return null to drop it. */
export type UsageOnRecord = (
  record: UsageRecord,
) => UsageRecord | null | Promise<UsageRecord | null>;

/** `createCopilotz` usage-tracking configuration. */
export interface UsageOptions {
  /** Disable usage persistence entirely. Defaults to enabled. */
  enabled?: boolean;
  /**
   * Resolve cost for a metered event. The native LLM path already supplies a
   * cost computed from OpenRouter pricing; override here to price tools/assets
   * or to adjust LLM pricing (e.g. markups, negotiated rates).
   */
  resolveCost?: UsageResolveCost;
  /** Optional final veto/transform before the ledger row is written. */
  onRecord?: UsageOnRecord;
}
