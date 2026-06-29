import type { MemoryResource } from "@/types/index.ts";

const longTermMemory: MemoryResource = {
  name: "long_term",
  kind: "long_term",
  description:
    "Checkpointed long-term conversation memory for stable prompt prefixes.",
  enabled: false,
  config: {
    triggerChars: 80_000,
    maxHotHistoryChars: 120_000,
    retainRecentChars: 0,
    maxContentChars: 48_000,
    retrievalLimit: 20,
  },
};

export default longTermMemory;
