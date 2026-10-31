/**
 * A space's invitations not yet accepted, for those who manage it: each
 * email, the role it's for, who invited them and when, and taking it back
 * (`invitation.decline`, as a manager). Nothing waiting, nothing shows.
 */
import { type ReactNode, useState } from "react";
import { Badge, Button, Card, Icon, message, Time } from "../../../../../hosts/web/mod.ts";
import type { Invitation } from "../../contract.ts";
import { roleName, whoOf } from "./who.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export function Pending(
  { invitations, me, call, heading = "h3", names = {} }: {
    invitations: Invitation[];
    me?: string;
    call: Call;
    heading?: "h3" | "h4";
    /** People by name (`namesIn`): who invited them. */
    names?: Record<string, string>;
  },
): ReactNode {
  if (!invitations.length) return null;
  const Heading = heading;
  return (
    <section className="space-section" aria-label="Invited, not joined yet">
      <Heading className="space-section-title">
        Invited <span className="space-count">{invitations.length}</span>
      </Heading>
      <ul className="space-rows">
        {invitations.map((i) => (
          <Row
            key={i._id}
            invitation={i}
            me={me}
            call={call}
            names={names}
          />
        ))}
      </ul>
    </section>
  );
}

function Row(
  { invitation: i, me, call, names }: {
    invitation: Invitation;
    me?: string;
    call: Call;
    names: Record<string, string>;
  },
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const by = whoOf(i.by, names);
  return (
    <Card as="li" padding="none" className="space-row space-row-invited">
      <span className="space-row-mark space-row-mail">
        <Icon name="mail" size={15} />
      </span>
      <div className="space-row-text">
        <p className="space-row-name">
          <span className="space-row-email">{i.email}</span>
          <Badge variant="outline">{roleName(i.role)}</Badge>
        </p>
        <p className="space-row-what">
          {error ?? (
            <>
              Invited by {by.id === me ? "you" : by.name} <Time at={i.at} long />
            </>
          )}
        </p>
      </div>
      <div className="space-row-end">
        <Button
          size="sm"
          variant="ghost"
          loading={busy}
          aria-label={`Take back the invitation to ${i.email}`}
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              await call("invitation.decline", { invitation: i._id });
            } catch (e) {
              setError(message(e));
              setBusy(false);
            }
          }}
        >
          Take back
        </Button>
      </div>
    </Card>
  );
}
