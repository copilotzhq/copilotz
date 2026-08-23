import type { LlmAdapter } from "../../contracts.ts";
import {
  createProviderAdapter,
  type LlmProviderAdapterConfig,
} from "../bridge.ts";
import { geminiProvider } from "./protocol.ts";

/** Capture Gemini credentials and transport configuration in one Adapter. */
export function createGeminiAdapter(
  configuration: LlmProviderAdapterConfig = {},
): LlmAdapter {
  return createProviderAdapter("gemini", configuration, geminiProvider);
}
