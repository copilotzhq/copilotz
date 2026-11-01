/**
 * What agents publish with: `publish`, what a job on the conversation's
 * space's computer serves, as an app of the space that runs on its own.
 * Always asked: its person (or the computer's owner) says yes first, as
 * for commands (`computer.allowed`), since it reaches outside the
 * computer. Listed in an agent's `tools` by name.
 */
import type { Tool } from "../../../agents/chat/contract.ts";
import { personOf } from "../../../../runtime/mod.ts";
import { tool } from "../../../agents/chat/contract.ts";
import { messageOf } from "../shared/errors.ts";
import { addressFor, detailOf, publish as publishApp } from "../shared/publish.ts";
import { may } from "../../../access/spaces/contract.ts";

const publish = tool({
  description: "Publishes what one of your jobs on this space's computers serves as an app " +
    "that runs on its own, without the computer, at an address of its own (https://<name>." +
    "copilotz.app, say): its folder is built (its Dockerfile, else an image running the job's " +
    "command as the computer does) and deployed. Give the job (one serving a port; it's " +
    "found on whichever computer runs it), or the port and the computer; path: a folder " +
    "under the space's folder, rather than all of it. Your person says yes first. It " +
    "answers at once with the address while it builds, which takes a few minutes. Publishing " +
    "the same name again publishes a new revision of that app.",
  input: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 80 },
      job: { type: "string", description: "The job's id (or name)." },
      port: { type: "integer", minimum: 1, maximum: 65535 },
      path: { type: "string" },
      computer: {
        type: "string",
        description: "Which of this space's computers it's on (its name), when not the " +
          "default and you give no job.",
      },
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
    if (!await may(ctx, "write", thread.in)) return "You can't publish from this space.";
    // Its person reads where it'll be: "wants to publish Shop at https://shop.copilotz.app".
    const address = await addressFor(ctx, thread.in, input.name).catch(() => undefined);
    // Asked of whoever answers on the computer that runs the job (not the default's), when only
    // the job says which.
    const computer = input.computer ??
      (input.job
        ? await ctx.call<{ computer: string }>("computer.scope", {
          in: thread.in,
          who: `agent:${ctx.agent}`,
          job: input.job,
        }).then((where) => where.computer, () => undefined)
        : undefined);
    const asked = await ctx.call<true | string>("computer.allowed", {
      thread: ctx.thread,
      agent: ctx.agent,
      kind: "publish",
      detail: detailOf(input),
      ...(computer ? { computer } : {}),
      ...(address ? { preview: address } : {}),
    });
    if (asked !== true) return asked;
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
