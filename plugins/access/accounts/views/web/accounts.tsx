/**
 * Your AI (kind `accounts`, at `/accounts`): first the sections other
 * front ends add (`accountSections`, each shown with the address's query:
 * the person's plans and computers); then each provider the app offers, as
 * a card (`account.providers`), with the person's account there (`account`,
 * which they read directly: their own only, never its tokens), live:
 * renewed, lost or disconnected, it shows at once; then the person's own API
 * keys. When a section shows the plans (`plans: true`), the providers that
 * pay for models (ChatGPT) are its, so they're not cards here, and the rest
 * are "Other accounts". Connecting opens its dialog; the address opens one
 * too (`?connect=github`, for one shown here), and says how a connection
 * that came back to the app went (`?connected=`, `?failed=…&why=`).
 */
import { Fragment, type ReactNode, useEffect, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Button,
  EmptyState,
  go,
  Icon,
  Notice,
  Page,
  sayText,
  Skeleton,
  Title,
} from "../../../../../hosts/web/mod.ts";
import type { Account, AccountSection, ProviderShown } from "../../contract.ts";
import { ProviderCard } from "./card.tsx";
import { ConnectDialog } from "./connect.tsx";
import { DisconnectDialog } from "./disconnect.tsx";
import { STYLE } from "./style.ts";
import { failedWhy, say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export const accountsView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const providers = ctx.db.collection("account").query<ProviderShown[]>("providers", {}).value;
  const accounts = ctx.db.collection<Account>("account").find({}).value;
  const query = (ctx.hints.query ?? {}) as Record<string, string>;
  const density = ctx.hints.mode === "panel" ? "panel" : "full";
  const style = <style href="accounts-web" precedence="copilotz">{STYLE}</style>;
  const TITLE = say("title");
  const ABOUT = say("about");
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
  // Other front ends' sections, first (`accountSections`), as the address asks.
  const given = sectionsOf(ctx.resources.accountSections);
  const sections = given.map((section) => (
    <Fragment key={section.key}>
      {ctx.show(section.view, {}, { query, mode: density })}
    </Fragment>
  ));
  // A section shows the plans: the providers that pay for models are its.
  const plans = given.some((section) => section.plans);
  const shown = plans ? providers.filter((p) => !p.models?.length) : providers;
  // The person's own API keys, below their accounts (`accounts.keys`).
  const keys = ctx.show("accounts.keys", {});
  return (
    <Page title={TITLE} description={ABOUT} icon="lock" density={density}>
      <Title text={TITLE} />
      {style}
      <AccountsBody
        providers={shown}
        titles={providers}
        accounts={accounts}
        query={query}
        call={ctx.call}
        sections={sections}
        {...(plans ? { heading: say("otherAccounts") } : {})}
      />
      {keys}
    </Page>
  );
};

/** The sections an `accountSections` resource adds, lowest `order` first (by key when they tie). */
export const sectionsOf = (given: unknown): (AccountSection & { key: string })[] =>
  Object.entries((given ?? {}) as Record<string, AccountSection | null>)
    .flatMap(([key, section]) => section?.view ? [{ ...section, key }] : [])
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.key.localeCompare(b.key));

function AccountsBody(
  { providers, titles, accounts, query, call, sections, heading }: {
    /** The providers shown here, as cards. */
    providers: ProviderShown[];
    /** Every provider, for what a notice names. */
    titles: ProviderShown[];
    accounts: Account[];
    query: Record<string, string>;
    call: Call;
    /** Other front ends' sections, shown first. */
    sections: ReactNode[];
    /** Over the cards, below the sections: "Other accounts". */
    heading?: string;
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
  const titleOf = (name?: string) =>
    sayText(titles.find((p) => p.name === name)?.title ?? name ?? "");
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
    return sections.length
      ? <div className="accounts">{sections}</div>
      : (
        <EmptyState icon="lock" title={say("nothing")}>
          {say("nothingText")}
        </EmptyState>
      );
  }
  return (
    <div className="accounts">
      {sections}
      {heading ? <h2 className="accounts-heading">{heading}</h2> : null}
      {came && query.connected && accountOf(query.connected)?.status === "connected"
        ? (
          <Notice
            tone="success"
            role="status"
            action={<Button size="sm" variant="ghost" onClick={clear}>{say("dismiss")}</Button>}
          >
            {say("connectedNotice", { provider: titleOf(query.connected) })}
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
                  {say("tryAgain")}
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
        <span>{say("foot")}</span>
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
