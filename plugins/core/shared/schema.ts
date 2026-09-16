/** Shared JSON Schema fragments for core collection records. */

export const metadataSchema = {
  type: "object",
} as const;

export const safeErrorSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    message: { type: "string" },
    code: { type: "string" },
    retryable: { type: "boolean" },
    metadata: metadataSchema,
  },
  required: ["message"],
} as const;

/** Provides JSON Schema fragments shared by Core Collections. @module */

export const timestampsSchema = {
  createdAt: { type: "string" },
  updatedAt: { type: "string" },
} as const;
