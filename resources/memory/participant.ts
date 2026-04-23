import type { MemoryResource } from "@/types/index.ts";

const participantMemory: MemoryResource = {
  name: "participant",
  kind: "participant",
  description:
    "Participant-backed memory for agent learnings, user identity binding, and prompt injection.",
  enabled: true,
};

export default participantMemory;
