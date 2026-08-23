import type { LlmAdapter } from "../../contracts.ts";
import {
  createProviderAdapter,
  type LlmProviderAdapterConfig,
} from "../bridge.ts";
import { deepseekProvider } from "./protocol.ts";

/** Capture DeepSeek credentials and transport configuration in one Adapter. */
export function createDeepSeekAdapter(
  configuration: LlmProviderAdapterConfig = {},
): LlmAdapter {
  return createProviderAdapter("deepseek", configuration, deepseekProvider);
}
