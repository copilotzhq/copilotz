import type { ResolvedContent } from "@copilotz/copilotz/content";

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value) &&
    value.every((entry) =>
      typeof entry === "string" && entry.trim().length > 0
    );
}

/**
 * Detached channel egress is limited to public conversation messages.
 * Missing visibility and history fields preserve legacy public rows; a
 * present private or malformed field fails closed.
 */
export function isPublicChannelMessage(value: unknown): boolean {
  const message = plainRecord(value);
  if (!message) return false;

  if (message.visibility !== undefined) {
    const visibility = plainRecord(message.visibility);
    if (!visibility || visibility.kind !== "public") return false;
  }
  if (
    message.historyScopeId !== undefined &&
    (typeof message.historyScopeId !== "string" ||
      message.historyScopeId.trim().length > 0)
  ) return false;
  if (
    message.recipientIds !== undefined &&
    !nonEmptyStringArray(message.recipientIds)
  ) return false;

  if (message.metadata === undefined) return true;
  const metadata = plainRecord(message.metadata);
  if (!metadata) return false;

  const agentTurn = metadata.copilotzAgentTurn;
  if (agentTurn !== undefined) {
    const turn = plainRecord(agentTurn);
    if (!turn) return false;
    if (turn.history !== undefined) return false;
  }

  const ask = metadata.copilotzAsk;
  if (ask !== undefined) {
    const candidate = plainRecord(ask);
    if (!candidate) return false;
    if (
      candidate.mode !== undefined && candidate.mode !== "public" &&
      candidate.mode !== "private"
    ) return false;
    if (candidate.mode === "private") return false;
  }
  return true;
}

export function requestHeader(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const normalized = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalized) return value;
  }
  return undefined;
}

export function timingSafeTextEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.byteLength ^ rightBytes.byteLength;
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export function outboundText(content: ResolvedContent): string | null {
  if (content.ref.kind === "text") return content.text?.trim() || null;
  if (content.ref.kind === "json") {
    return (content.text ?? JSON.stringify(content.value))?.trim() || null;
  }
  return null;
}

export function requiredProviderText(
  value: unknown,
  label: string,
): string {
  const normalized = typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
  if (!normalized) throw new TypeError(`${label} must be non-empty.`);
  return normalized;
}

export function providerRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
