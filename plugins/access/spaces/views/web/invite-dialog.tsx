/**
 * The dialog that adds to a space, for those who manage it: the space's
 * invite surface (`space.invite`), read only while it's open, the same one
 * the command palette shows. Opened from the header's Invite, at People;
 * from the Members tab's "Add an agent", at Agents (`tab`), said so.
 */
import type { ReactNode } from "react";
import { Button, Dialog, LazyView, Skeleton } from "../../../../../hosts/web/mod.ts";
import type { Space } from "../../contract.ts";
import { spaceName } from "./who.ts";

/** What the dialog says it's for: its title, and what joining means. */
export const inviteTitle = (name: string) => `Invite someone to ${name}`;
export const INVITE_ABOUT =
  "They'll see what's in it (its chats, memories and computers) and work with its agents.";

/** The same, opened to add an agent. */
export const addAgentTitle = (name: string) => `Add an agent to ${name}`;
export const AGENT_ABOUT =
  "Agents work for whoever asks them, and reach only what that person can.";

export function InviteDialog(
  { open, onClose, space, tab }: {
    open: boolean;
    onClose(): void;
    space: Pick<Space, "_id" | "name" | "kind">;
    /** The tab it opens at: `agents`, or people. */
    tab?: string;
  },
): ReactNode {
  const agents = tab === "agents";
  const name = spaceName(space);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={agents ? addAgentTitle(name) : inviteTitle(name)}
      description={agents ? AGENT_ABOUT : INVITE_ABOUT}
      footer={<Button onClick={onClose}>Done</Button>}
    >
      {open
        ? (
          <LazyView
            kind="space.invite"
            item={{ _id: space._id }}
            hints={{ in: space._id, ...(tab ? { tab } : {}) }}
            fallback={<Skeleton height={40} radius="lg" />}
          />
        )
        : null}
    </Dialog>
  );
}
