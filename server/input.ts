/** Intersects trusted operation fields with client values before execution. @module */
import { stableStringify } from "../runtime/collections/equal.ts";
export function constrainInput(
  input: unknown,
  constraints?: Readonly<Record<string, unknown>>,
): unknown {
  if (!constraints) return input;
  const forbidden = () =>
    Object.assign(new Error("Input conflicts with enforced policy."), {
      status: 403,
      code: "forbidden",
    });
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw forbidden();
  }
  const result = { ...input as Record<string, unknown> };
  for (const [key, value] of Object.entries(constraints)) {
    if (
      key in result && stableStringify(result[key]) !== stableStringify(value)
    ) throw forbidden();
    result[key] = value;
  }
  return result;
}
