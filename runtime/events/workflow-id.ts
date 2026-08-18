import { digestContent } from "../content/digest.ts";

/** Leaves headroom when a consumer composes this ID into a 256-byte field. */
export const MAX_DERIVED_WORKFLOW_ID_LENGTH = 192;

const encoder = new TextEncoder();

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
 * bound into a deterministic SHA-256 identity.
 */
export async function deriveWorkflowId(
  kindInput: string,
  ...partInputs: string[]
): Promise<string> {
  const kind = workflowIdKind(kindInput);
  const parts = partInputs.map(workflowIdPart);
  const readable = [kind, ...parts].join(":");
  if (readable.length <= MAX_DERIVED_WORKFLOW_ID_LENGTH) return readable;

  const canonical = JSON.stringify([
    "copilotz.workflow-id.v1",
    kind,
    ...parts,
  ]);
  return `${kind}:${await digestContent(encoder.encode(canonical))}`;
}
