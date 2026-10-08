/** Preferred-model history capacity after its prompt prefix and one response. @module */
import { type LlmCallInput, prepareLlmCall } from "@copilotz/copilotz/llm";

export async function historyLimitEstimatedTokens(
  input: LlmCallInput,
  connections: Parameters<typeof prepareLlmCall>[1],
  namespace: string,
): Promise<number> {
  const prefix = await prepareLlmCall(
    {
      ...input,
      models: [input.models[0]],
      request: { ...input.request, messages: [] },
    },
    connections,
    namespace,
  );
  const preferred = prefix.candidates[0]!;
  return Math.max(
    0,
    Math.floor(
      preferred.limitEstimatedInputTokens -
        preferred.estimatedInputTokens -
        (preferred.outputTokenAllowance ?? 1_000),
    ),
  );
}
