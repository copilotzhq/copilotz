/**
 * Who's signed in, at the foot of the sidebar, and their menu: what front
 * ends put there (the `userMenu` resource: `{ label, icon?, href, order? }`,
 * Connected accounts, say); where the app serves many orgs, the org's
 * settings (or what it is, for those who don't run it) and, for staff,
 * every org; then signing out (of every org). With nothing in it, signing
 * out is a button of its own.
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
import { runs, type Standing } from "../shared/orgs.ts";

export function Me(
  { name, email, menu = [], orgs }: {
    name: string;
    email?: string | null;
    /** What front ends put in the menu, in their order. */
    menu?: UserMenuEntry[];
    /** Where the app serves many orgs: whether they're in one, their standing there, staff. */
    orgs?: { here: boolean; standing?: Standing; staff: boolean };
  },
): ReactNode {
  const [leaving, setLeaving] = useState(false);
  const leave = () => {
    setLeaving(true);
    void signOut();
  };
  const own: MenuItem[] = [
    ...menu.map(({ label, icon, href }) => ({ label, href, ...(icon ? { icon } : {}) })),
    ...(orgs?.here
      ? [{
        label: runs(orgs.standing) ? "Organization settings" : "About this organization",
        icon: "settings" as const,
        href: "/org",
      }]
      : []),
    ...(orgs?.staff
      ? [{ label: "All orgs (console)", icon: "server" as const, href: "/console" }]
      : []),
  ];
  const who = (
    <>
      <Avatar name={name} size={32} />
      <span className="copilotz-me-who">
        <span className="copilotz-me-name">{name}</span>
        <span className="copilotz-me-note">{email && email !== name ? email : "Signed in"}</span>
      </span>
    </>
  );
  if (!own.length) {
    return (
      <div className="copilotz-me">
        {who}
        <IconButton icon="signout" label="Sign out" loading={leaving} onClick={leave} />
      </div>
    );
  }
  return (
    <div className="copilotz-me copilotz-me-menu">
      <Menu
        label="Your account"
        side="top"
        items={[...own, "separator", { label: "Sign out", icon: "signout", onSelect: leave }]}
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
