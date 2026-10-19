import { captureHostCommandJson } from "../application/host-command-json.ts";
import { validateAgainstJsonSchema } from "../collections/validate.ts";
import { splitSecretActionValue } from "./secret.ts";
import { sameActionValue } from "./value.ts";
import type { AnyActionDefinition } from "./types.ts";
function redacted(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    (value as Record<string, unknown>)["$copilotz-secret"] === true;
}
/** Omits only schema-redacted values and explicitly registered revision fields. */
export function protectedActionPublicInput(
  action: AnyActionDefinition,
  input: unknown,
  revisions: readonly string[] = [],
): unknown {
  const allowed = new Set(revisions);
  const visit = (value: unknown, path: string): unknown => {
    if (allowed.has(path) || redacted(value)) return undefined;
    if (Array.isArray(value)) {
      return value.map((child, index) =>
        visit(child, `${path}/${index}`) ?? null
      );
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).flatMap(([key, child]) => {
          const result = visit(
            child,
            `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
          );
          return result === undefined ? [] : [[key, result]];
        }),
      );
    }
    return value;
  };
  return visit(
    splitSecretActionValue(action.inputSchema, input).publicValue,
    "",
  ) ?? null;
}
export function capturePreparedActionInput(
  action: AnyActionDefinition,
  original: unknown,
  result: unknown,
  revisions: readonly string[] = [],
): unknown {
  const captured = captureHostCommandJson(result);
  try {
    if (action.inputSchema) {
      validateAgainstJsonSchema(
        action.inputSchema,
        captured,
        "Protected Action input",
      );
    }
    if (
      !sameActionValue(
        protectedActionPublicInput(action, original, revisions),
        protectedActionPublicInput(action, captured, revisions),
      )
    ) {
      throw new Error("changed input");
    }
  } catch {
    throw new TypeError(
      "Protected Action preparation changed an undeclared field or produced invalid input.",
    );
  }
  return captured;
}
