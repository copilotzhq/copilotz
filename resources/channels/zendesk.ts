import type { Copilotz } from "@/index.ts";
import { zendeskChannel } from "@/server/channels/zendesk.ts";

export default async function (
  ctx: { method: string; headers: Record<string, string>; body: unknown },
  copilotz: Copilotz,
) {
  return zendeskChannel(
    { method: ctx.method, url: "", headers: new Headers(ctx.headers), body: ctx.body },
    copilotz,
  );
}
