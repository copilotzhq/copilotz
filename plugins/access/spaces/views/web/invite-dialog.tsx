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
import { say } from "./words.ts";

/** What the dialog says it's for: its title, and what joining means. */
export const inviteTitle = (name: string) => say("inviteTitle", { name });
export const inviteAbout = () => say("inviteAbout");

/** The same, opened to add an agent. */
export const addAgentTitle = (name: string) => say("addAgentTitle", { name });
export const addAgentAbout = () => say("addAgentAbout");

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
      description={agents ? addAgentAbout() : inviteAbout()}
      footer={<Button onClick={onClose}>{say("done")}</Button>}
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
