/** Provides the latest settled semantic memory as conversation context. @module */
import { createMemoryContextResource as createImplementation } from "../../internal/implementation.ts";
import type { ContextResource } from "@copilotz/copilotz/core";

export function createMemoryContextResource(
  enabled: boolean,
): ContextResource & Readonly<{ historyAfterMessageId?: string }> {
  return createImplementation(enabled);
}
