/**
 * Connected accounts (kind `accounts`, at `/accounts`): each provider the
 * app offers, as a card (`account.providers`), with the person's account
 * there (`account`, which they read directly: their own only, never its
 * tokens), live: renewed, lost or disconnected, it shows at once.
 * Connecting opens its dialog; the address opens one too
 * (`?connect=chatgpt`: the command palette's), and says how a connection
 * that came back to the app went (`?connected=`, `?failed=…&why=`).
 */
import { type ReactNode, useEffect, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Button,
  EmptyState,
  go,
  Icon,
  Notice,
  Page,
  Skeleton,
  Title,
} from "../../../../../hosts/web/mod.ts";
import type { Account, ProviderShown } from "../../contract.ts";
import { ProviderCard } from "./card.tsx";
import { ConnectDialog } from "./connect.tsx";
import { DisconnectDialog } from "./disconnect.tsx";
import { STYLE } from "./style.ts";
import { failedWhy } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

const TITLE = "Connected accounts";
const ABOUT = "Connect an account once, and agents working for you use it. Nobody else can: " +
  "not the people you share spaces with, nor their agents.";

export const accountsView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const providers = ctx.db.collection("account").query<ProviderShown[]>("providers", {}).value;
  const accounts = ctx.db.collection<Account>("account").find({}).value;
  const query = (ctx.hints.query ?? {}) as Record<string, string>;
  const density = ctx.hints.mode === "panel" ? "panel" : "full";
  const style = <style href="accounts-web" precedence="copilotz">{STYLE}</style>;
  if (!providers || !accounts) {
    return (
      <Page title={TITLE} description={ABOUT} icon="lock" density={density}>
        <Title text={TITLE} />
        {style}
        <div className="account-skeleton" aria-busy="true">
          <Skeleton height={112} radius="xl" />
        </div>
      </Page>
    );
  }
  return (
    <Page title={TITLE} description={ABOUT} icon="lock" density={density}>
      <Title text={TITLE} />
      {style}
      <AccountsBody providers={providers} accounts={accounts} query={query} call={ctx.call} />
    </Page>
  );
};

function AccountsBody(
  { providers, accounts, query, call }: {
    providers: ProviderShown[];
    accounts: Account[];
    query: Record<string, string>;
    call: Call;
  },
): ReactNode {
  const asked = providers.some((p) => p.name === query.connect) ? query.connect : undefined;
  const [connecting, setConnecting] = useState<string | undefined>(asked);
  // Asked for by the address (the palette's "Connect…"), on this page already or not.
  useEffect(() => {
    if (asked) setConnecting(asked);
  }, [asked]);
  const [leaving, setLeaving] = useState<string>();
  const accountOf = (name?: string) => accounts.find((a) => a.provider === name);
  const titleOf = (name?: string) => providers.find((p) => p.name === name)?.title ?? name ?? "";
  const came = query.connected ?? query.failed;
  const clear = () => go("/accounts");
  const closeConnect = () => {
    setConnecting(undefined);
    if (query.connect) clear();
  };
  const connectingTo = providers.find((p) => p.name === connecting);
  const leavingFrom = providers.find((p) => p.name === leaving);
  const leavingAccount = accountOf(leaving);

  if (!providers.length) {
    return (
      <EmptyState icon="lock" title="Nothing to connect yet">
        This app doesn't offer accounts to connect.
      </EmptyState>
    );
  }
  return (
    <div className="accounts">
      {came && query.connected && accountOf(query.connected)?.status === "connected"
        ? (
          <Notice
            tone="success"
            role="status"
            action={<Button size="sm" variant="ghost" onClick={clear}>Dismiss</Button>}
          >
            {titleOf(query.connected)} is connected: agents working for you use it from now on.
          </Notice>
        )
        : came && query.failed
        ? (
          <Notice
            tone="warning"
            role="alert"
            action={providers.some((p) => p.name === query.failed)
              ? (
                <Button
                  size="sm"
                  onClick={() => setConnecting(query.failed)}
                >
                  Try again
                </Button>
              )
              : null}
          >
            {failedWhy(query.why, titleOf(query.failed))}
          </Notice>
        )
        : null}
      <ul className="accounts-list">
        {providers.map((provider) => (
          <ProviderCard
            key={provider.name}
            provider={provider}
            account={accountOf(provider.name)}
            onConnect={() => setConnecting(provider.name)}
            onDisconnect={() => setLeaving(provider.name)}
          />
        ))}
      </ul>
      <p className="accounts-foot">
        <Icon name="lock" size={14} />
        <span>
          Sign-ins stay on the server, never shown in the app or to agents' models. Disconnecting
          ends them at the provider too.
        </span>
      </p>
      {connectingTo
        ? (
          <ConnectDialog
            key={connectingTo.name}
            provider={connectingTo}
            open={!!connecting}
            again={!!accountOf(connectingTo.name)}
            onClose={closeConnect}
            call={call}
          />
        )
        : null}
      {leavingFrom && leavingAccount
        ? (
          <DisconnectDialog
            provider={leavingFrom}
            account={leavingAccount}
            open={!!leaving}
            onClose={() => setLeaving(undefined)}
            call={call}
          />
        )
        : null}
    </div>
  );
}
