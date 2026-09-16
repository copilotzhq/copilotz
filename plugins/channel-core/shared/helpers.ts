import type { ResolvedContent } from "@copilotz/copilotz/content";

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
