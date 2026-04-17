import type { Copilotz } from "@/index.ts";
import { whatsappChannel } from "@/server/channels/whatsapp.ts";

export default async function (
  ctx: { method: string; headers: Record<string, string>; body: unknown },
  copilotz: Copilotz,
) {
  return whatsappChannel(
    { method: ctx.method, url: "", headers: new Headers(ctx.headers), body: ctx.body },
    copilotz,
  );
}
