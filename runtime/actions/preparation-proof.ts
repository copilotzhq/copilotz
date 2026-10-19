/** Corroborates the receipt with the existing integrity-checked invoked Event Body.
 * This checksum detects retained-data substitution; it never grants permission. */
import { digestContent } from "../content/digest.ts";
import { preparationCanonical, preparationData } from "./preparation-data.ts";
export const NAMED_PREPARATION_MARKER = "__copilotzPreparation";
export const NAMED_PREPARATION_INTEGRITY = "__copilotzPreparationIntegrity";
export function preparationIntegrity(
  input: Readonly<
    { binding: unknown; capture: unknown; identity: unknown; intent: unknown }
  >,
): Promise<string> {
  return digestContent(
    new TextEncoder().encode(preparationCanonical(preparationData(input))),
  );
}
