import type { MemoryResource } from "@/types/index.ts";

const longTermMemory: MemoryResource = {
  name: "long_term",
  kind: "long_term",
  description:
    "Checkpointed long-term conversation memory for stable prompt prefixes.",
  enabled: false,
  config: {
    triggerEstimatedTokens: 20_000,
    retainRecentEstimatedTokens: 0,
    maxContentEstimatedTokens: 12_000,
    retrievalLimit: 20,
  },
};

export default longTermMemory;
