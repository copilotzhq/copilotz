/** Reusable credential Resource declarations for built-in LLM providers. @module */

import {
  type LlmCredentialContext,
  type LlmCredentialExecution,
  type LlmCredentialResolution,
  type LlmCredentialResource,
  normalizeLlmCredential,
} from "../../internal/contracts.ts";

export type {
  LlmCredentialContext,
  LlmCredentialExecution,
  LlmCredentialResolution,
  LlmCredentialResource,
};

/** Validates and freezes one reusable process-local credential Resource. */
export function defineLlmCredential(
  resource: LlmCredentialResource,
): LlmCredentialResource {
  return normalizeLlmCredential(resource);
}
