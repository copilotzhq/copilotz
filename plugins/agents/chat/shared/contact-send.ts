/**
 * The app's `contactSend` hooks: what lets a contact's message in (a web
 * line's limits, the files it takes, its visitor's own chat), and each file
 * it uploads to send (`chat.attach`), counted as a message to nobody.
 */
import type { Context } from "../../../../runtime/mod.ts";

/**
 * A `contactSend` resource: the Action that lets a contact's message in,
 * asked as the contact before anything's sent, with where it goes (`thread`,
 * when it names one), what it carries (each file's name, media type and
 * size), and `to: []` when it goes to nobody (no agent answers it: no turn
 * to pay for). Each file a contact uploads to send is asked first too, as a
 * message to nobody carrying it. It refuses it (a limit), or answers where it goes when it names no
 * chat (`thread`: the contact's own) and `transcribe: false` when its audio
 * goes untranscribed.
 */
export type ContactSend = { action: string };

/** What the app's `contactSend` hooks say of a contact's message, each in turn. */
export async function letIn(
  ctx: Pick<Context, "resources" | "call">,
  asked: {
    thread?: string;
    files: { name: string; type?: string; size: number }[];
    to?: [];
  },
): Promise<{ thread?: string; transcribe?: false }> {
  const hooks = Object.values((ctx.resources.contactSend ?? {}) as Record<string, ContactSend>);
  let said: { thread?: string; transcribe?: false } = {};
  for (const hook of hooks) {
    const answer = await ctx.call<{ thread?: unknown; transcribe?: unknown } | null>(hook.action, {
      ...(asked.thread ? { thread: asked.thread } : {}),
      files: asked.files,
      ...(asked.to ? { to: asked.to } : {}),
    });
    said = {
      ...said,
      ...(typeof answer?.thread === "string" && !said.thread ? { thread: answer.thread } : {}),
      ...(answer?.transcribe === false ? { transcribe: false as const } : {}),
    };
  }
  return said;
}
