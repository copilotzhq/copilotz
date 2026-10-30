/**
 * Invitations to the person, at the top of the sidebar (kind
 * `invitations`): a calm card each, to join or decline there, the newest
 * first; the rest counted, all of them on home (where the sidebar leaves
 * them to it). Nothing waiting, nothing shows. Live: one sent to them
 * appears, one taken back goes.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { NavItem } from "../../../../../hosts/web/mod.ts";
import type { Invitation } from "../../contract.ts";
import { InvitationCard } from "./invitation.tsx";
import { STYLE } from "./style.ts";

/** At most this many show in the sidebar. */
const SHOWN = 2;

export const invitationsView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const mine = ctx.db.collection("invitation").query<Invitation[]>("mine", {}).value ?? [];
  // Home shows them all, over its greeting.
  if (!mine.length || ctx.hints.path === "/") return null;
  return (
    <>
      <style href="spaces-web" precedence="copilotz">{STYLE}</style>
      <ul className="invitations invitations-compact" aria-label="Invitations">
        {mine.slice(0, SHOWN).map((i) => (
          <InvitationCard key={i._id} invitation={i} call={ctx.call} compact />
        ))}
        {mine.length > SHOWN
          ? (
            <li>
              <NavItem quiet href="/" icon="mail">
                {mine.length - SHOWN} more invitation{mine.length - SHOWN === 1 ? "" : "s"}
              </NavItem>
            </li>
          )
          : null}
      </ul>
    </>
  );
};
