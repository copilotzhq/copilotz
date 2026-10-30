/**
 * What agents publish with: `publish`, what a job on the conversation's
 * space's computer serves, as an app of the space that runs on its own.
 * Always asked: its person (or the computer's owner) says yes first, as
 * for commands (`computer.allowed`), since it reaches outside the
 * computer. Listed in an agent's `tools` by name.
 */
import type { Tool } from "../../../agents/chat/contract.ts";
import { tool } from "../../../agents/chat/contract.ts";
import { messageOf } from "../shared/errors.ts";
import { addressFor, can, detailOf, personOf, publish as publishApp } from "../shared/publish.ts";

const publish = tool({
  description: "Publishes what one of your jobs on this space's computer serves as an app " +
    "that runs on its own, without the computer, at an address of its own (https://<name>." +
    "copilotz.app, say): its folder is built (its Dockerfile, else buildpacks, running the " +
    "job's command) and deployed. Give the job (one serving a port), or the port; path: a " +
    "folder under the space's folder, rather than all of it. Your person says yes first. It " +
    "answers at once with the address while it builds, which takes a few minutes. Publishing " +
    "the same name again publishes a new revision of that app.",
  input: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 80 },
      job: { type: "string", description: "The job's id (or name)." },
      port: { type: "integer", minimum: 1, maximum: 65535 },
      path: { type: "string" },
    },
    required: ["name"],
  },
  run: async (input, ctx) => {
    const person = personOf(ctx.actor);
    if (!person) return "There's no person this work is for, so nothing to publish for.";
    if (!input.job && !input.port) {
      return "Which port does it serve? Give its job (one serving a port) or the port.";
    }
    // Read as the agent (for its person): a conversation they don't reach has no space for them.
    const thread = await ctx.db.collection<{ in?: string }>("thread").findOne({ _id: ctx.thread });
    if (!thread?.in) {
      return "This conversation isn't in a space, so there's no computer to publish from.";
    }
    if (!await can(ctx, thread.in, "write")) return "You can't publish from this space.";
    // Its person reads where it'll be: "wants to publish Shop at https://shop.copilotz.app".
    const address = await addressFor(ctx, thread.in, input.name).catch(() => undefined);
    const may = await ctx.call<true | string>("computer.allowed", {
      thread: ctx.thread,
      agent: ctx.agent,
      kind: "publish",
      detail: detailOf(input),
      ...(address ? { preview: address } : {}),
    });
    if (may !== true) return may;
    try {
      const published = await publishApp(ctx, {
        ...input,
        in: thread.in,
        who: `agent:${ctx.agent}`,
        by: person,
      });
      return {
        ...published,
        note: `Building it now: it's live at ${published.url} in a few minutes. The space's ` +
          "apps show how it's going.",
      };
    } catch (error) {
      return `Error: ${messageOf(error)}`;
    }
  },
});

/** By the names agents list them under. */
export const tools: Record<string, Tool> = { publish };
