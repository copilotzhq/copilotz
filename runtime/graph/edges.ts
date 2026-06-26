export const GRAPH_EDGE = {
  PARTICIPATES_IN: "participates_in",
  HAS_CHILD_THREAD: "has_child_thread",
  HAS_MESSAGE: "has_message",
  SENT_BY: "sent_by",
  HAS_TOOL_CALL: "has_tool_call",
  HAS_TOOL_RESULT: "has_tool_result",
  HAS_TOOL_EXECUTION: "has_tool_execution",
  HAS_LLM_ATTEMPT: "has_llm_attempt",
  /** Thread or parent resource owns a usage ledger row. */
  HAS_USAGE: "has_usage",
  /** Agent participant generated/performed a usage ledger row. */
  GENERATED_USAGE: "generated_usage",
  /** Participant initiated a usage ledger row (human, agent, or job). */
  INITIATED_USAGE: "initiated_usage",
  /** @deprecated Prefer {@link GRAPH_EDGE.HAS_USAGE}. Legacy LLM-only edge. */
  HAS_LLM_USAGE: "has_llm_usage",
  /** @deprecated Prefer {@link GRAPH_EDGE.GENERATED_USAGE}. Legacy LLM-only edge. */
  USED_LLM: "used_llm",
  /** @deprecated Prefer {@link GRAPH_EDGE.INITIATED_USAGE}. Legacy LLM-only edge. */
  INITIATED_LLM_USAGE: "initiated_llm_usage",
  HAS_ASSET: "has_asset",
  HAS_VARIANT: "has_variant",
  CREATED_ASSET: "created_asset",
  HAS_DOCUMENT: "has_document",
  HAS_CHUNK: "has_chunk",
  USES_KNOWLEDGE_SPACE: "uses_knowledge_space",
  CAN_ACCESS: "can_access",
  CREATED_BY: "created_by",
  DERIVED_FROM: "derived_from",
  FORKED_FROM: "forked_from",
  MENTIONS: "mentions",
} as const;

export type GraphEdgeType = typeof GRAPH_EDGE[keyof typeof GRAPH_EDGE];
