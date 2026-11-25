/** The schema defineAction supplies when its declaration takes no parameters. */
export const emptyInput = { type: "object", properties: {}, additionalProperties: false } as const;

/** Calling a parameterless Action with no argument is the same call as passing {}. */
export const actionInput = (def: { input?: unknown }, given: unknown) =>
  given === undefined && def.input === emptyInput ? {} : given;
