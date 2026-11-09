/**
 * Who's signed in, at the foot of the sidebar, and their menu: what front
 * ends put there (the `userMenu` resource: `{ label, icon?, href, order? }`,
 * Connected accounts, say), then what the `orgs` slot lists where the app
 * serves many orgs (the org's settings; every org, for staff), then signing
 * out (of every org). With nothing in it, signing out is a button of its own.
 */
import { type ReactNode, useState } from "react";
import {
  Avatar,
  Icon,
  IconButton,
  Menu,
  type MenuItem,
  signOut,
} from "../../../../hosts/web/mod.ts";
import type { UserMenuEntry } from "../shared/menu.ts";
import { say } from "./words.ts";

export function Me(
  { name, email, menu = [] }: {
    name: string;
    email?: string | null;
    /** What front ends put in the menu, in their order (and the `orgs` slot's, after). */
    menu?: UserMenuEntry[];
  },
): ReactNode {
  const [leaving, setLeaving] = useState(false);
  const leave = () => {
    setLeaving(true);
    void signOut();
  };
  const own: MenuItem[] = menu.map(({ label, icon, href }) => ({
    label,
    href,
    ...(icon ? { icon } : {}),
  }));
  const who = (
    <>
      <Avatar name={name} size={32} />
      <span className="copilotz-me-who">
        <span className="copilotz-me-name">{name}</span>
        <span className="copilotz-me-note">
          {email && email !== name ? email : say("signedIn")}
        </span>
      </span>
    </>
  );
  if (!own.length) {
    return (
      <div className="copilotz-me">
        {who}
        <IconButton icon="signout" label={say("signOut")} loading={leaving} onClick={leave} />
      </div>
    );
  }
  return (
    <div className="copilotz-me copilotz-me-menu">
      <Menu
        label={say("yourAccount")}
        side="top"
        items={[...own, "separator", { label: say("signOut"), icon: "signout", onSelect: leave }]}
        trigger={(props) => (
          <button type="button" {...props} className="copilotz-me-button">
            {who}
            <Icon name="selector" size={15} className="copilotz-me-chevron" />
          </button>
        )}
      />
    </div>
  );
}
