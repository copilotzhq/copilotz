/** Shared JSON Schema fragments for core collection records. */

export const metadataSchema = {
  type: "object",
} as const;

export const timestampsSchema = {
  createdAt: { type: "string" },
  updatedAt: { type: "string" },
} as const;
