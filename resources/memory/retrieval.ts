import type { MemoryResource } from "@/types/index.ts";

const retrievalMemory: MemoryResource = {
  name: "retrieval",
  kind: "retrieval",
  description:
    "Retrieval-backed memory over graph-stored document and chunk nodes for contextual knowledge injection.",
  enabled: true,
};

export default retrievalMemory;
