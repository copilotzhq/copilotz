import type { MemoryResource } from "@/types/index.ts";

const historyMemory: MemoryResource = {
  name: "history",
  kind: "history",
  description:
    "Conversation history memory that formats prior messages and applies history-window policies.",
  enabled: true,
};

export default historyMemory;
