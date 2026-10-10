export function updateInputSchema(
  schema: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  if (!schema) {
    return {
      type: "object",
      properties: {
        set: { type: "object" },
        unset: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    };
  }
  const set = structuredClone(schema) as Record<string, unknown>;
  delete set.required;
  return {
    type: "object",
    properties: {
      set,
      unset: { type: "array", items: { type: "string" }, uniqueItems: true },
    },
    additionalProperties: false,
  };
}

export function createInputSchema(
  schema: Readonly<Record<string, unknown>> | undefined,
  defaults?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!schema) return { type: "object" };
  const input = structuredClone(schema) as Record<string, unknown>;
  const properties = input.properties;
  if (
    properties && typeof properties === "object" && !Array.isArray(properties)
  ) {
    const next = { ...(properties as Record<string, unknown>) };
    for (const field of ["namespace", "createdAt", "updatedAt"]) {
      delete next[field];
    }
    input.properties = next;
  }
  if (Array.isArray(input.required)) {
    const generated = new Set([
      "id",
      "namespace",
      "createdAt",
      "updatedAt",
      ...Object.keys(defaults ?? {}),
    ]);
    input.required = input.required.filter((field) =>
      !generated.has(String(field))
    );
  }
  return input;
}
