/**
 * Moving a chat to another space (`chat.move`), as a command palette step:
 * spaces' picker (`space.pick`, by name: the spaces the person may write
 * in, but the one it's in), then, before anything moves, a question: moving
 * it shares it, so it says who'll see the whole conversation there and what
 * it drew on (`chat.moving`), with "Move to Launch" first and "Keep it where
 * it is" back to the spaces. Then the move, with everything in it (its
 * notes too). A chat that's open opens again in its new space; one moved
 * from a list leaves it. Every way to move a chat comes here: its header's
 * menu, a space's list, the palette.
 */
import { go, LazyView, type PaletteStep, Skeleton } from "../../../../../hosts/web/mod.ts";
import { shortened } from "./plain.ts";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** A space picked to move to, as the picker hands it. */
type Picked = { _id: string; name: string; kind: string };

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
    title: say("moveTitle", { title: shortened(title) }),
    placeholder: say("findSpace"),
    note: say("moveNote"),
    view: "space.pick",
    hints: from ? { from } : {},
    pick: (space, palette) =>
      palette.push(confirmStep({ thread, title, call, open, to: space as Picked })),
  };
}

/** Whether to move it there, once they've read who'll see it. */
function confirmStep(
  { thread, title, call, open, to }: {
    thread: string;
    title: string;
    call: Call;
    open?: boolean;
    to: Picked;
  },
): PaletteStep {
  const space = to.kind === "personal" ? say("personal") : to.name;
  return {
    title: say("moveConfirm", { title: shortened(title), space }),
    confirm: true,
    note: (
      <LazyView
        kind="chat.moving"
        item={{ _id: thread }}
        hints={{ to: to._id }}
        fallback={<Skeleton height={14} width="82%" className="chat-moving-wait" />}
      />
    ),
    items: () => [{
      title: "",
      items: [
        {
          key: "chat:move",
          label: say("moveTo", { space }),
          icon: "move",
          run: async () => {
            await call("chat.move", { thread, to: to._id });
            if (open) go(`/thread/${encodeURIComponent(thread)}?in=${encodeURIComponent(to._id)}`);
          },
        },
        {
          key: "chat:keep",
          label: say("keepWhereItIs"),
          icon: "close",
          run: (palette) => palette.back(),
        },
      ],
    }],
  };
}
