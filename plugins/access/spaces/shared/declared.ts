/**
 * Spaces the app declares (the `spaces` resource, by id): its own, owned by
 * nobody but the system, made and kept as declared when something needs them
 * (`space.keep`: a WhatsApp line the app declares keeps its space). Each is a
 * space like any other (reach, rules, members): its name and its agents are
 * the app's, so people neither rename it nor take its agents out.
 *
 * ```ts
 * resources: { spaces: { line: { name: "Mobifácil", agents: ["booking"] } } }
 * ```
 */
import type { Context } from "../../../../runtime/mod.ts";

/** A declared space: its name, and the agents working there (editors; the first answers new chats). */
export type DeclaredSpace = { name: string; agents?: string[] };

/** The space `id`, as the app declares it, if it does. */
export const declaredOf = (ctx: Pick<Context, "resources">, id: string) =>
  ((ctx.resources.spaces ?? {}) as Record<string, DeclaredSpace | null>)[id] ?? undefined;

/** Whether `agent` is one of the agents the app declares in space `id`. */
export const declaredAgent = (ctx: Pick<Context, "resources">, id: string, agent: string) =>
  !!declaredOf(ctx, id)?.agents?.includes(agent);
