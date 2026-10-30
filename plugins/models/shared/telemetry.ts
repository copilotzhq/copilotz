/**
 * OpenTelemetry's GenAI metrics for a model call: how long it took
 * (`gen_ai.client.operation.duration`, seconds) and the tokens it used
 * (`gen_ai.client.token.usage`), plus, for streamed answers, the time to the
 * first piece (`copilotz.llm.time_to_first_token`). Nothing without metrics.
 */
import type { Attributes, Metrics } from "../../../runtime/mod.ts";
import type { Resolved } from "./choice.ts";
import type { Usage } from "./provider.ts";

// The buckets OpenTelemetry's GenAI conventions recommend.
const SECONDS = [
  0.01,
  0.02,
  0.04,
  0.08,
  0.16,
  0.32,
  0.64,
  1.28,
  2.56,
  5.12,
  10.24,
  20.48,
  40.96,
  81.92,
];
const TOKENS = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216];

export function measure(
  metrics: Metrics | undefined,
  model: Resolved,
  operation: "chat" | "embeddings" | "transcription",
) {
  const started = performance.now();
  const attributes: Attributes = {
    "gen_ai.operation.name": operation,
    "gen_ai.provider.name": model.provider,
    "gen_ai.request.model": model.model,
  };
  let first = false;
  return {
    /** The first piece of the answer arrived. */
    first() {
      if (first || !metrics) return;
      first = true;
      metrics.histogram("copilotz.llm.time_to_first_token", {
        unit: "s",
        description: "Time to the first text or tool call of a streamed answer",
        buckets: SECONDS,
      }).record((performance.now() - started) / 1000, attributes);
    },
    usage(usage: Usage) {
      if (!metrics) return;
      const tokens = metrics.histogram("gen_ai.client.token.usage", {
        unit: "{token}",
        description: "Tokens used by a model call",
        buckets: TOKENS,
      });
      if (usage.input) tokens.record(usage.input, { ...attributes, "gen_ai.token.type": "input" });
      if (usage.output) {
        tokens.record(usage.output, { ...attributes, "gen_ai.token.type": "output" });
      }
    },
    /** The call ended, failed with `error` if given. */
    end(error?: unknown) {
      metrics?.histogram("gen_ai.client.operation.duration", {
        unit: "s",
        description: "Duration of model calls",
        buckets: SECONDS,
      }).record(
        (performance.now() - started) / 1000,
        error === undefined ? attributes : {
          ...attributes,
          "error.type": String(
            (error as { code?: string; status?: number }).status ??
              (error as { code?: string }).code ?? "error",
          ),
        },
      );
    },
  };
}
