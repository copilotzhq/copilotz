/** History capacity after the ordinary prompt prefix and one model response. @module */
import { type LlmCallInput, prepareLlmCall } from "@copilotz/copilotz/llm";

export async function historyLimitEstimatedTokens(
  input: LlmCallInput,
  connections: Parameters<typeof prepareLlmCall>[1],
  namespace: string,
): Promise<number> {
  const prefix = await prepareLlmCall(
    {
      ...input,
      request: { ...input.request, messages: [] },
    },
    connections,
    namespace,
  );
  return Math.max(
    0,
    Math.floor(Math.max(...prefix.candidates.map((candidate) => {
      return candidate.limitEstimatedInputTokens -
        candidate.estimatedInputTokens -
        (candidate.outputTokenAllowance ?? 1_000);
    }))),
  );
}
