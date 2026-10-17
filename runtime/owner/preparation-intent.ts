/** Host-only semantic preparation identity. Transport incarnation, renderer
 * implementation and current source values are deliberately not key inputs. */
import { digestContent } from "../content/digest.ts";
import { assertJsonValue } from "../json.ts";

export type OwnerPreparationIntentFacts = Readonly<{
  preparation: string;
  operationKey: string;
  parentOperationKey: string;
  source: string;
  recordId: string;
  actionId: string;
  hints: Readonly<{ mode: string; renderer: "text" }>;
}>;

/** Exact canonical bytes already used by the named preparation command. */
export async function ownerPreparationIntent(
  input: OwnerPreparationIntentFacts,
): Promise<Readonly<{ encoding: "copilotz.preparation.v1"; digest: string }>> {
  assertJsonValue(input, { maxDepth: 3, maxNodes: 20 });
  const stringFields = [
    "preparation",
    "operationKey",
    "parentOperationKey",
    "source",
    "recordId",
    "actionId",
  ] as const;
  const fields = [...stringFields, "hints"];
  if (
    Object.keys(input).sort().join(",") !== fields.sort().join(",") ||
    stringFields.some((key) => {
      const value = input[key];
      return typeof value !== "string" || !value || value !== value.trim() ||
        value.length > 1024;
    }) || !input.hints || typeof input.hints !== "object" ||
    Object.keys(input.hints).sort().join(",") !== "mode,renderer" ||
    typeof input.hints.mode !== "string" || !input.hints.mode ||
    input.hints.mode !== input.hints.mode.trim() ||
    input.hints.mode.length > 1024 ||
    input.hints.renderer !== "text"
  ) throw new TypeError("Invalid preparation intent facts.");
  function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return `{${
        Object.keys(record).sort().map((key) =>
          `${JSON.stringify(key)}:${canonical(record[key])}`
        ).join(",")
      }}`;
    }
    return JSON.stringify(value);
  }
  // Encode synchronously: caller alias changes during digest cannot rebind it.
  const bytes = new TextEncoder().encode(canonical(input));
  return {
    encoding: "copilotz.preparation.v1",
    digest: await digestContent(bytes),
  };
}
