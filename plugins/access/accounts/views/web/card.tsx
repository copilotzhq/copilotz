/**
 * A provider on Connected accounts: what connecting it allows, how the
 * person's account there stands, and what to do: connect it; once
 * connected, who it is (its plan, when it was signed in and renewed) and
 * disconnecting; when it needs them, why, and reconnecting.
 */
import type { ReactNode } from "react";
import { Badge, Button, Card, Icon, Notice, Time } from "../../../../../hosts/web/mod.ts";
import type { Account, ProviderShown } from "../../contract.ts";
import { standing } from "./words.ts";

export function ProviderCard(
  { provider, account, onConnect, onDisconnect }: {
    provider: ProviderShown;
    account?: Account;
    onConnect(): void;
    onDisconnect(): void;
  },
): ReactNode {
  const { label, tone } = standing(account);
  const connected = account?.status === "connected";
  const titleId = `account-${provider.name}`;
  return (
    <Card as="li" padding="none" className="account" aria-labelledby={titleId}>
      <div className="account-head">
        <span className="account-mark" aria-hidden="true">
          <Icon name={provider.icon ?? "lock"} size={20} />
        </span>
        <div className="account-titles">
          <h2 className="account-title" id={titleId}>
            {provider.title}
            {account ? <Badge tone={tone}>{label}</Badge> : null}
          </h2>
          <p className="account-allows">{provider.allows}</p>
        </div>
        <div className="account-actions">
          {!account
            ? (
              <Button variant="primary" onClick={onConnect}>
                Connect {provider.title}
              </Button>
            )
            : connected
            ? <Button onClick={onDisconnect}>Disconnect</Button>
            : (
              <>
                <Button variant="ghost" onClick={onDisconnect}>Disconnect</Button>
                <Button variant="primary" icon="refresh" onClick={onConnect}>Reconnect</Button>
              </>
            )}
        </div>
      </div>
      {account && !connected
        ? (
          <Notice className="account-problem" tone="warning">
            {account.problem ?? "It needs signing in again."}{" "}
            {provider.models?.length ? "Until then, agents use the app's own models." : ""}
          </Notice>
        )
        : null}
      {account
        ? (
          <div className="account-who">
            <div className="account-who-text">
              <span className="account-label">{account.label}</span>
              <span className="account-facts">
                {account.plan ? `${account.plan} plan · ` : ""}
                Connected <Time at={account.connected} />
                {account.refreshed && account.refreshed > account.connected
                  ? (
                    <>
                      {" · "}renewed <Time at={account.refreshed} />
                    </>
                  )
                  : null}
              </span>
            </div>
          </div>
        )
        : null}
    </Card>
  );
}
