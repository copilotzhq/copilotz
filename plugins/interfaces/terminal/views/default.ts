/**
 * Anything without a terminal View of its own: its fields, one per line,
 * nested ones indented. Every kind prints something, so a plugin writes a
 * View only where this isn't good enough.
 */
import { dim, short } from "../../../../hosts/terminal/contract.ts";

function lines(value: unknown, indent: string): string[] {
  if (value === null || value === undefined) return [`${indent}${dim("—")}`];
  if (typeof value !== "object") return [`${indent}${short(String(value), 200)}`];
  if (Array.isArray(value)) {
    return value.length
      ? value.flatMap((v) => lines(v, `${indent}- `))
      : [`${indent}${dim("(none)")}`];
  }
  return Object.entries(value).flatMap(([key, v]) =>
    v !== null && typeof v === "object" && Object.keys(v).length
      ? [`${indent}${dim(`${key}:`)}`, ...lines(v, `${indent}  `)]
      : [
        `${indent}${dim(`${key}:`)} ${
          typeof v === "object" ? dim("(none)") : short(String(v), 200)
        }`,
      ]
  );
}

export const defaultView = (item: unknown): string => lines(item, "").join("\n");
