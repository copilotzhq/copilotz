/**
 * The WhatsApp plugin's settings (the `whatsapp` resource): where Meta's
 * Graph API is (its version; a test's fake), how long a code to link a
 * phone lasts, and the largest file a message may bring.
 */
import type { Resources } from "../../../../runtime/mod.ts";

export type WhatsAppSettings = { graph?: string; codeMinutes?: number; maxFileMb?: number };

export const settingsOf = (ctx: { resources: Resources }) => {
  const set = (ctx.resources.whatsapp ?? {}) as WhatsAppSettings;
  return {
    graph: (set.graph ?? "https://graph.facebook.com/v23.0").replace(/\/+$/, ""),
    codeMinutes: set.codeMinutes ?? 15,
    // What chat takes as a file, at most.
    maxFileBytes: Math.min(set.maxFileMb ?? 10, 10) * 1024 * 1024,
  };
};
