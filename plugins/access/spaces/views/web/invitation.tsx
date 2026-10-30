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

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export function InvitationCard(
  { invitation: i, call, compact }: { invitation: Invitation; call: Call; compact?: boolean },
): ReactNode {
  const [busy, setBusy] = useState<"accept" | "decline">();
  const [error, setError] = useState<string>();
  const by = whoOf(i.by).id;
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
        {compact ? "Join" : `Join ${i.name}`}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        loading={busy === "decline"}
        disabled={!!busy}
        onClick={() => void answer("decline")}
      >
        Decline
      </Button>
    </div>
  );
  return (
    <Card
      as="li"
      padding="none"
      className={`invitation${compact ? " invitation-compact" : ""}`}
      aria-label={`Invitation to ${i.name}`}
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
          {compact
            ? (
              <>
                Invited to <b>{i.name}</b>
              </>
            )
            : (
              <>
                <b>{by}</b> invited you to <b>{i.name}</b>, as {aRole(i.role)}.
              </>
            )}
        </p>
        <p className="invitation-meta">
          {error ?? (compact
            ? (
              <>
                By {by} · as {aRole(i.role)}
              </>
            )
            : (
              <>
                Invited{" "}
                <Time at={i.at} long />. Joining shows you its chats, memories and computers.
              </>
            ))}
        </p>
        {compact ? buttons : null}
      </div>
      {compact ? null : buttons}
    </Card>
  );
}
