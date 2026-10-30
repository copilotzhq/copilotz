/**
 * Moving a memory to another space (`memory.move`), as a command palette
 * step: spaces' picker (`space.pick`, by name: the spaces the person may
 * write in, but the one it was learned in), then the move. It's then
 * recalled as learned there.
 */
import type { PaletteStep } from "../../../../../hosts/web/mod.ts";
import type { Memory } from "../../collections/memory.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** A memory, short enough to say in a step's name. */
export const gist = (text: string, most = 36) =>
  text.length > most ? `${text.slice(0, most - 1).trimEnd()}…` : text;

export function moveStep(memory: Pick<Memory, "_id" | "text" | "in">, call: Call): PaletteStep {
  return {
    title: `Move “${gist(memory.text)}” to…`,
    placeholder: "Find a space",
    note: "Agents then recall it as learned there, for the people in that space.",
    view: "space.pick",
    hints: memory.in ? { from: memory.in } : {},
    pick: (space) =>
      call("memory.move", { memory: memory._id, to: (space as { _id: string })._id }),
  };
}
