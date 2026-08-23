import type { LlmAdapter } from "../../contracts.ts";
import {
  createProviderAdapter,
  type LlmProviderAdapterConfig,
} from "../bridge.ts";
import { groqProvider } from "./protocol.ts";

/** Capture Groq credentials and transport configuration in one Adapter. */
export function createGroqAdapter(
  configuration: LlmProviderAdapterConfig = {},
): LlmAdapter {
  return createProviderAdapter("groq", configuration, groqProvider);
}
