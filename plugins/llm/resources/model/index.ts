/** Model Resource declarations and normalization for LLM execution. @module */

import {
  type LlmBuiltinModelResource,
  type LlmBuiltinProvider,
  type LlmCredentialSource,
  type LlmCustomModelResource,
  type LlmJsonObject,
  type LlmJsonValue,
  type LlmMode,
  type LlmRuntimeDiagnostics,
  type ModelResource,
  normalizeModel,
} from "../../internal/contracts.ts";

export type {
  LlmBuiltinModelResource,
  LlmBuiltinProvider,
  LlmCredentialSource,
  LlmCustomModelResource,
  LlmJsonObject,
  LlmJsonValue,
  LlmMode,
  LlmRuntimeDiagnostics,
  ModelResource,
};

/** Validates and freezes one Model Resource without registering it. */
export function defineModel<TOptions extends LlmJsonObject = LlmJsonObject>(
  resource: ModelResource<TOptions>,
): ModelResource<TOptions> {
  return normalizeModel(resource);
}
