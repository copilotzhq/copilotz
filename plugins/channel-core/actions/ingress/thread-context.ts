import {
  normalizeThreadMetadata,
  type StructuredThreadMetadata,
} from "@copilotz/copilotz/core";
/** Channel ingress owns its system metadata namespace. */
export function setChannelContext(
  raw: unknown,
  channel: string,
  patch: Record<string, unknown>,
): StructuredThreadMetadata {
  const value = normalizeThreadMetadata(raw);
  const channels = (value.system?.channels ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  return {
    ...value,
    system: {
      ...value.system,
      channels: { ...channels, [channel]: { ...channels[channel], ...patch } },
    },
  };
}
