/**
 * Picking one of a space's memories to move (kind `memory.pick`, a command
 * palette step's View, hints `{ in }`): what was learned there, newest
 * first, found by what it says and whom it's about (an agent as it's
 * named: chat's `agentsShown`); chosen, the next step picks where it goes.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import type { PaletteGroup } from "../../../../../hosts/web/mod.ts";
import { type Agent, agentsShown } from "../../../chat/contract.ts";
import type { Memory } from "../../collections/memory.ts";
import { moveStep } from "./move.ts";

/** Whom a memory is about, as a line says it. */
const aboutOf = (about: string, me?: string, agents: Record<string, Agent> = {}) => {
  const [kind, name] = about.split(/:(.*)/);
  if (kind === "person") return name === me ? "About you" : `About ${name}`;
  if (kind === "agent") return `About ${agents[name]?.name || name}`;
  if (kind === "thread") return "About a chat";
  return "About everyone";
};

export const memoryPickView = (_: unknown, ctx: ViewContext<ReactNode>): PaletteGroup[] | null => {
  const space = typeof ctx.hints.in === "string" ? ctx.hints.in : undefined;
  if (!space) return [];
  const memories = ctx.db.collection("memory").query<Memory[]>("list", { in: space, limit: 200 })
    .value;
  if (!memories) return null;
  const agents = agentsShown(
    ctx,
    memories.flatMap((m) => m.about.startsWith("agent:") ? [m.about.slice(6)] : []),
  );
  if (!agents) return null;
  return [{
    title: "Memories",
    limit: 12,
    items: memories.map((m) => ({
      key: `memory:${m._id}`,
      label: m.text,
      icon: m.core ? "star" as const : "sparkles" as const,
      description: aboutOf(m.about, ctx.viewer?.name, agents),
      keywords: [m.about, m.by],
      step: moveStep(m, ctx.call),
    })),
  }];
};
