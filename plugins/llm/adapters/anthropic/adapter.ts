import type { LlmAdapter } from "../../contracts.ts";
import {
  createProviderAdapter,
  type LlmProviderAdapterConfig,
} from "../bridge.ts";
import { anthropicProvider } from "./protocol.ts";

/** Capture Anthropic credentials and transport configuration in one Adapter. */
export function createAnthropicAdapter(
  configuration: LlmProviderAdapterConfig = {},
): LlmAdapter {
  return createProviderAdapter("anthropic", configuration, anthropicProvider);
}
