/** Who's signed in, at the foot of the sidebar, and signing out. */
import { type ReactNode, useState } from "react";
import { Avatar, IconButton, signOut } from "../../../../hosts/web/mod.ts";

export function Me({ name }: { name: string }): ReactNode {
  const [leaving, setLeaving] = useState(false);
  return (
    <div className="copilotz-me">
      <Avatar name={name} size={32} />
      <div className="copilotz-me-who">
        <span className="copilotz-me-name">{name}</span>
        <span className="copilotz-me-note">Signed in</span>
      </div>
      <IconButton
        icon="signout"
        label="Sign out"
        loading={leaving}
        onClick={() => {
          setLeaving(true);
          void signOut();
        }}
      />
    </div>
  );
}
