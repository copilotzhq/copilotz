import type { LlmAdapter } from "../../contracts.ts";
import {
  createProviderAdapter,
  type LlmProviderAdapterConfig,
} from "../bridge.ts";
import { minimaxProvider } from "./protocol.ts";

/** Capture MiniMax credentials and transport configuration in one Adapter. */
export function createMinimaxAdapter(
  configuration: LlmProviderAdapterConfig = {},
): LlmAdapter {
  return createProviderAdapter("minimax", configuration, minimaxProvider);
}
