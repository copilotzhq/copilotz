/**
 * Moving a chat to another space (`chat.move`), as a command palette step:
 * spaces' picker (`space.pick`, by name: the spaces the person may write
 * in, but the one it's in), then the move, with everything in it. A chat
 * that's open opens again in its new space; one moved from a list leaves it.
 */
import { go, type PaletteStep } from "../../../../../hosts/web/mod.ts";
import { shortened } from "./plain.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export function moveStep(
  { thread, title, from, call, open }: {
    thread: string;
    title: string;
    /** The space it's in. */
    from?: string;
    call: Call;
    /** It's the chat open: it opens again, in its new space. */
    open?: boolean;
  },
): PaletteStep {
  return {
    title: `Move “${shortened(title)}” to…`,
    placeholder: "Find a space",
    note: "Its messages, files and subthreads go with it, for the people in that space to see.",
    view: "space.pick",
    hints: from ? { from } : {},
    pick: async (space) => {
      const to = (space as { _id: string })._id;
      await call("chat.move", { thread, to });
      if (open) go(`/thread/${encodeURIComponent(thread)}?in=${encodeURIComponent(to)}`);
    },
  };
}
