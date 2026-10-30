/**
 * Moving one of the person's computers from a space to another
 * (`computer.move`), as a command palette step: spaces' picker
 * (`space.pick`, by name: the spaces they may write in, but the one it's
 * in), then the move. It gets a folder there and answers as it did; its
 * folder here stays on the machine.
 */
import type { PaletteStep } from "../../../../../hosts/web/mod.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export function moveStep(
  { desk, name, from, call }: { desk: string; name: string; from: string; call: Call },
): PaletteStep {
  return {
    title: `Move ${name} to…`,
    placeholder: "Find a space",
    note: "It gets a folder there, and asks as it does here. Its folder here stays on the machine.",
    view: "space.pick",
    hints: { from },
    pick: (space) => call("computer.move", { desk, to: (space as { _id: string })._id }),
  };
}
