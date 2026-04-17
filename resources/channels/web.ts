import type { Copilotz } from "@/index.ts";

export default async function (
  ctx: { body: unknown; callback?: (event: unknown) => void },
  copilotz: Copilotz,
) {
  if (!ctx.callback) {
    throw { status: 400, message: "Web channel requires a callback for streaming" };
  }
  const controller = await copilotz.run(ctx.body as any);
  for await (const event of controller.events as AsyncIterable<unknown>) {
    ctx.callback(event);
  }
  return { status: "ok" };
}
