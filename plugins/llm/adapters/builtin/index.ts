/** Built-in provider Adapter materialization. @module */

import type {
  LlmAdapter,
  LlmAdapterCallInput,
  LlmBuiltinProviderConfiguration,
  LlmJsonObject,
  LlmMode,
} from "../../shared/contracts.ts";
import {
  createProviderAdapter,
  prepareProviderAttemptTranscript,
  validateBuiltinProviderCall,
} from "../bridge/index.ts";
import { builtinProviders } from "./providers.ts";

/** Materializes one resolved built-in provider configuration without exposing it. */
export function materializeBuiltinModel(
  resource: LlmBuiltinProviderConfiguration,
  mode: LlmMode,
  options: LlmJsonObject,
): LlmAdapter {
  validateBuiltinProviderCall(resource.provider, mode, options);
  return createProviderAdapter(
    resource.provider,
    resource,
    builtinProviders[resource.provider],
  );
}

/** Internal bridge used to admit and execute the same built-in transcript. */
export function prepareBuiltinModelTranscript(
  resource: LlmBuiltinProviderConfiguration,
  mode: LlmMode,
  options: LlmJsonObject,
  input: LlmAdapterCallInput,
  calibrationFactor?: number,
) {
  validateBuiltinProviderCall(resource.provider, mode, options);
  return prepareProviderAttemptTranscript(
    resource.provider,
    resource,
    builtinProviders[resource.provider],
    input,
    calibrationFactor,
  );
}
