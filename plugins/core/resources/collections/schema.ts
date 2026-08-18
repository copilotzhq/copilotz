/** Shared JSON Schema fragments for core collection records. */

export const contentRefSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    assetId: { type: "string" },
    kind: { type: "string" },
    role: { type: "string" },
    mediaType: { type: "string" },
    name: { type: "string" },
    alt: { type: "string" },
    language: { type: "string" },
    disposition: { type: "string" },
    metadata: { type: "object" },
  },
  required: ["assetId", "kind", "role", "mediaType"],
} as const;

export const contentSequenceSchema = {
  type: "array",
  items: contentRefSchema,
} as const;

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

export const timestampsSchema = {
  createdAt: { type: "string" },
  updatedAt: { type: "string" },
} as const;
