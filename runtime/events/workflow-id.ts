import { digestContent } from "../content/digest.ts";

/** Leaves headroom when a consumer composes this ID into a 256-byte field. */
export const MAX_DERIVED_WORKFLOW_ID_LENGTH = 192;

const encoder = new TextEncoder();

function readablePart(value: string): string {
  let encoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const safe = (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      code === 0x2d || code === 0x2e || code === 0x5f || code === 0x7e;
    encoded += safe ? value[index] : `%${code.toString(16).padStart(4, "0")}`;
  }
  return encoded;
}

function workflowIdKind(value: string): string {
  const kind = value.trim();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(kind)) {
    throw new TypeError("Workflow ID kind must be a lowercase identifier.");
  }
  return kind;
}

function workflowIdPart(value: string): string {
  if (!value) throw new TypeError("Workflow ID parts must be non-empty.");
  return value;
}

/**
 * Preserves short readable IDs and compacts ancestry that would grow without
 * bound into a deterministic SHA-256 identity. Each readable part is encoded
 * independently, so delimiters inside caller-controlled values cannot alias a
 * different tuple. An empty first segment cannot be emitted by that encoding
 * and therefore safely distinguishes the compact representation from every
 * readable identity.
 */
export async function deriveWorkflowId(
  kindInput: string,
  ...partInputs: string[]
): Promise<string> {
  const kind = workflowIdKind(kindInput);
  const parts = partInputs.map(workflowIdPart);
  const readable = [kind, ...parts.map(readablePart)].join(":");
  if (
    encoder.encode(readable).byteLength <= MAX_DERIVED_WORKFLOW_ID_LENGTH
  ) return readable;

  const canonical = JSON.stringify([
    "copilotz.workflow-id.v2",
    kind,
    ...parts,
  ]);
  return `${kind}::${await digestContent(encoder.encode(canonical))}`;
}
