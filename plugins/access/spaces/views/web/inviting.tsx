/**
 * Adding to a space (kind `space.invite`, item `{ _id }`, the space): what
 * the header's Invite dialog, the Members tab's "Add an agent" and the
 * command palette show. A tab per kind of member: People (by email, with
 * the invitations still waiting under it, each to take back), then the
 * kinds other front ends add (`spaceInvite`: team's Agents), each its own
 * View, read only once its tab is chosen; `hints.tab` says which opens
 * first. A Personal space takes only the kinds that join one (agents). For
 * those who manage the space; anyone else is told who does.
 */
import { type ReactNode, useId, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { LazyView, Notice, Skeleton, Tabs } from "../../../../../hosts/web/mod.ts";
import type { Invitation, Reached } from "../../contract.ts";
import { InviteForm } from "./invite.tsx";
import { Pending } from "./pending.tsx";
import { STYLE } from "./style.ts";
import { type Kind, kindsOf } from "./tabs.ts";
import { spaceName } from "./who.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export const invitingView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const id = item._id ?? (typeof ctx.hints.in === "string" ? ctx.hints.in : "");
  const spaces = ctx.db.collection("space").query<Reached[]>("reached", {}).value;
  // Only those who manage it read them (the rules): anyone else, none.
  const invitations = ctx.db.collection<Invitation>("invitation").find({ space: id }, {
    sort: { at: -1 },
  }).value;
  const style = <style href="spaces-web" precedence="copilotz">{STYLE}</style>;
  if (spaces === undefined || invitations === undefined) {
    return (
      <div className="space-inviting" aria-busy="true">
        {style}
        <Skeleton height={40} radius="lg" />
      </div>
    );
  }
  const space = spaces.find((s) => s._id === id);
  const personal = space?.kind === "personal";
  const kinds = kindsOf(ctx.resources.spaceInvite, personal);
  if (!space || !space.can.includes("manage") || !kinds.length) {
    return (
      <Notice tone="neutral" icon="lock">
        {personal
          ? "Personal is yours alone. To work with others, make a shared space and invite them there."
          : `Those who manage ${space ? spaceName(space) : "this space"} add people to it.`}
      </Notice>
    );
  }
  return (
    <>
      {style}
      <Inviting
        space={space}
        kinds={kinds}
        first={typeof ctx.hints.tab === "string" ? ctx.hints.tab : undefined}
        invitations={invitations}
        me={ctx.viewer?.name}
        call={ctx.call}
      />
    </>
  );
};

function Inviting(
  { space, kinds, first, invitations, me, call }: {
    space: Reached;
    kinds: Kind[];
    first?: string;
    invitations: Invitation[];
    me?: string;
    call: Call;
  },
): ReactNode {
  const [kind, setKind] = useState(() => kinds.find((k) => k.key === first)?.key ?? kinds[0].key);
  const id = useId();
  const shown = kinds.find((k) => k.key === kind) ?? kinds[0];
  return (
    <div className="space-inviting">
      {kinds.length > 1
        ? (
          <Tabs
            label="Who to add"
            value={shown.key}
            onChange={setKind}
            panel={`${id}-kind`}
            tabs={kinds.map((k) => ({ value: k.key, label: k.title }))}
          />
        )
        : null}
      <div id={`${id}-kind`} role={kinds.length > 1 ? "tabpanel" : undefined}>
        {shown.view
          ? (
            <LazyView
              key={shown.key}
              kind={shown.view}
              item={{ _id: space._id }}
              hints={{ in: space._id }}
              fallback={<Skeleton height={160} radius="lg" />}
            />
          )
          : (
            <div className="space-inviting-kind">
              <InviteForm space={space} call={call} autoFocus />
              <Pending invitations={invitations} me={me} call={call} />
            </div>
          )}
      </div>
    </div>
  );
}
