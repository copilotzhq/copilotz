/**
 * Invitations to the person, on home (kind `invitations.home`, chat's
 * `home` resource): over the greeting, a card each, saying who invited them
 * where and as what, and what joining means, to join or decline. Nothing
 * waiting, nothing shows.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import type { Invitation } from "../../contract.ts";
import { InvitationCard } from "./invitation.tsx";
import { STYLE } from "./style.ts";
import { namesIn } from "../../shared/names.ts";

export const invitedView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const mine = ctx.db.collection("invitation").query<Invitation[]>("mine", {}).value ?? [];
  if (!mine.length) return null;
  const names = namesIn(ctx, mine.map((i) => i.by));
  return (
    <>
      <style href="spaces-web" precedence="copilotz">{STYLE}</style>
      <ul className="invitations" aria-label="Invitations">
        {mine.map((i) => (
          <InvitationCard
            key={i._id}
            invitation={i}
            call={ctx.call}
            names={names}
          />
        ))}
      </ul>
    </>
  );
};
