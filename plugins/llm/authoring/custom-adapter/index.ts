/** Custom LLM Adapter authoring contract and validation helper. @module */

import {
  type LlmAdapter,
  type LlmAdapterAttempt,
  LlmAdapterCallError,
  type LlmAdapterCallInput,
  type LlmAdapterContentPart,
  type LlmAdapterFrame,
  type LlmAdapterMessage,
  type LlmAdapterRequest,
  type LlmAdapterResult,
  type LlmInvocation,
  type LlmRejectedAttemptEvidence,
  normalizeLlmAdapter,
} from "../../internal/contracts.ts";

export { LlmAdapterCallError };
export type {
  LlmAdapter,
  LlmAdapterAttempt,
  LlmAdapterCallInput,
  LlmAdapterContentPart,
  LlmAdapterFrame,
  LlmAdapterMessage,
  LlmAdapterRequest,
  LlmAdapterResult,
  LlmInvocation,
  LlmRejectedAttemptEvidence,
};

/** Validates and freezes an application-defined executable Adapter. */
export function createLlmAdapter<const TAdapter extends LlmAdapter>(
  adapter: TAdapter,
): TAdapter {
  return normalizeLlmAdapter(adapter);
}
