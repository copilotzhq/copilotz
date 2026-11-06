/**
 * An invitation to the person, as a calm card: the space, who invited them
 * and as what, with Join (`invitation.accept`, then the space's page opens)
 * and Decline (`invitation.decline`). `compact` in the sidebar; on home,
 * with a line on what joining means.
 */
import { type ReactNode, useState } from "react";
import { Avatar, Button, Card, go, Icon, message, Time } from "../../../../../hosts/web/mod.ts";
import type { Invitation } from "../../contract.ts";
import { spacePath } from "./tabs.ts";
import { aRole, whoOf } from "./who.ts";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export function InvitationCard(
  { invitation: i, call, compact, names = {} }: {
    invitation: Invitation;
    call: Call;
    compact?: boolean;
    /** People by name (`namesIn`): who invited them. */
    names?: Record<string, string>;
  },
): ReactNode {
  const [busy, setBusy] = useState<"accept" | "decline">();
  const [error, setError] = useState<string>();
  const by = whoOf(i.by, names).name;
  const answer = async (how: "accept" | "decline") => {
    setBusy(how);
    setError(undefined);
    try {
      if (how === "decline") return void await call("invitation.decline", { invitation: i._id });
      const { space } = await call<{ space: string }>("invitation.accept", { invitation: i._id });
      go(spacePath(space));
    } catch (e) {
      setError(message(e));
      setBusy(undefined);
    }
  };
  const buttons = (
    <div className="invitation-answers">
      <Button
        size="sm"
        variant="primary"
        loading={busy === "accept"}
        disabled={!!busy}
        onClick={() => void answer("accept")}
      >
        {compact ? say("join") : say("joinNamed", { name: i.name })}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        loading={busy === "decline"}
        disabled={!!busy}
        onClick={() => void answer("decline")}
      >
        {say("decline")}
      </Button>
    </div>
  );
  return (
    <Card
      as="li"
      padding="none"
      className={`invitation${compact ? " invitation-compact" : ""}`}
      aria-label={say("invitationTo", { name: i.name })}
    >
      {compact
        ? (
          <span className="invitation-mark">
            <Icon name="mail" size={14} />
          </span>
        )
        : <Avatar name={i.name} kind="space" size={40} className="invitation-space" />}
      <div className="invitation-text">
        <p className="invitation-title">
          {compact ? say.nodes("invitedTo", { space: <b>{i.name}</b> }) : say.nodes("invitedYou", {
            by: <b>{by}</b>,
            space: <b>{i.name}</b>,
            role: aRole(i.role),
          })}
        </p>
        <p className="invitation-meta">
          {error ?? (compact
            ? say("byAs", { by, role: aRole(i.role) })
            : say.nodes("invitedAt", { time: <Time at={i.at} long /> }))}
        </p>
        {compact ? buttons : null}
      </div>
      {compact ? null : buttons}
    </Card>
  );
}
