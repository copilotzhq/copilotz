/**
 * Disconnecting an account, once the person has read what it means: agents
 * working for them stop using it (and use the app's models, where there
 * are some), and the provider is asked to end the sign-in.
 */
import { type ReactNode, useState } from "react";
import { Button, Dialog, message, Notice } from "../../../../../hosts/web/mod.ts";
import type { Account, ProviderShown } from "../../contract.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export function DisconnectDialog(
  { provider, account, open, onClose, call }: {
    provider: ProviderShown;
    account: Account;
    open: boolean;
    onClose(): void;
    call: Call;
  },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const disconnect = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await call("account.disconnect", { provider: provider.name });
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const what = provider.models?.length ? "plan" : "account";
  const said = `Agents working for you stop using your ${provider.title} ${what} ` +
    `(${account.label})${
      provider.models?.length ? ", and use the app's own models instead" : ""
    }. ` +
    `${provider.title} is told to end this sign-in too. You can connect it again any time.`;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={`Disconnect ${provider.title}?`}
      footer={
        <>
          <Button onClick={onClose}>Keep it</Button>
          <Button variant="destructive" loading={busy} onClick={() => void disconnect()}>
            Disconnect
          </Button>
        </>
      }
    >
      <p className="accounts-quiet">{said}</p>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
    </Dialog>
  );
}
