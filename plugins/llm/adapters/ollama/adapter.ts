import type { LlmAdapter } from "../../contracts.ts";
import {
  createProviderAdapter,
  type LlmProviderAdapterConfig,
} from "../bridge.ts";
import { ollamaProvider } from "./protocol.ts";

/** Capture the Ollama endpoint and transport configuration in one Adapter. */
export function createOllamaAdapter(
  configuration: LlmProviderAdapterConfig = {},
): LlmAdapter {
  return createProviderAdapter("ollama", configuration, ollamaProvider);
}
