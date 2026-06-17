export const GRAPH_EDGE = {
  PARTICIPATES_IN: "participates_in",
  HAS_CHILD_THREAD: "has_child_thread",
  HAS_MESSAGE: "has_message",
  SENT_BY: "sent_by",
  HAS_TOOL_CALL: "has_tool_call",
  HAS_TOOL_RESULT: "has_tool_result",
  HAS_LLM_USAGE: "has_llm_usage",
  USED_LLM: "used_llm",
  INITIATED_LLM_USAGE: "initiated_llm_usage",
  HAS_ASSET: "has_asset",
  CREATED_ASSET: "created_asset",
  HAS_DOCUMENT: "has_document",
  HAS_CHUNK: "has_chunk",
  USES_KNOWLEDGE_SPACE: "uses_knowledge_space",
  CAN_ACCESS: "can_access",
  CREATED_BY: "created_by",
  DERIVED_FROM: "derived_from",
  MENTIONS: "mentions",
} as const;

export type GraphEdgeType = typeof GRAPH_EDGE[keyof typeof GRAPH_EDGE];
