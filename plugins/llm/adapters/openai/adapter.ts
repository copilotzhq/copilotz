import type { LlmAdapter } from "../../contracts.ts";
import {
  createProviderAdapter,
  type LlmProviderAdapterConfig,
} from "../bridge.ts";
import { openaiProvider } from "./protocol.ts";

/** Capture OpenAI credentials and transport configuration in one Adapter. */
export function createOpenAiAdapter(
  configuration: LlmProviderAdapterConfig = {},
): LlmAdapter {
  return createProviderAdapter("openai", configuration, openaiProvider);
}
