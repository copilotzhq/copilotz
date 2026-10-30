/**
 * Connecting a WhatsApp Business number to a space, in a dialog, by hand:
 * where in Meta's dashboard each thing is, then its phone number id, an
 * access token and the app's secret (Meta is asked first, so a wrong one
 * says so). Connected, the last step: the webhook to give Meta, its
 * callback URL and verify token to copy (`Webhook`, again from a number's
 * menu). Replacing a number's token, and disconnecting it, after asking.
 */
import { type ReactNode, useEffect, useState } from "react";
import {
  appBase,
  Button,
  CodeBlock,
  Dialog,
  Field,
  Input,
  message,
  Notice,
  Skeleton,
} from "../../../../../hosts/web/mod.ts";
import type { WhatsAppNumber } from "../../contract.ts";
import { unreachable } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

type Hook = { path: string; verify: string };

const META = "https://developers.facebook.com/apps/";

/** The webhook to give Meta: where it is and its verify token, to copy. */
export function Webhook({ hook }: { hook?: Hook }): ReactNode {
  const origin = appBase();
  return (
    <div className="wa-hook">
      <p className="wa-note">
        In your Meta app:{" "}
        <b>WhatsApp → Configuration → Webhook → Edit</b>. Paste these, verify and save, then under
        {" "}
        <b>Webhook fields</b> subscribe to <b>messages</b>.
      </p>
      <div className="wa-hook-field">
        <span>Callback URL</span>
        {hook
          ? <CodeBlock code={`${origin}${hook.path}`} copy label="Callback URL" />
          : <Skeleton height={40} radius="lg" />}
      </div>
      <div className="wa-hook-field">
        <span>Verify token</span>
        {hook
          ? <CodeBlock code={hook.verify} copy label="Verify token" />
          : <Skeleton height={40} radius="lg" />}
      </div>
      {unreachable(origin)
        ? (
          <Notice tone="warning" title="Meta can't reach this address">
            It calls a public <code>https://</code>{" "}
            address. While you try it here, put one in front of this app (a tunnel such as
            cloudflared or ngrok) and use that address instead.
          </Notice>
        )
        : null}
    </div>
  );
}

export function ConnectDialog(
  { open, onClose, space, where, call }: {
    open: boolean;
    onClose(): void;
    space: string;
    where: string;
    call: Call;
  },
): ReactNode {
  const [fields, setFields] = useState({ phoneId: "", token: "", secret: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [made, setMade] = useState<Hook & { number: string }>();
  useEffect(() => {
    if (!open) return;
    setFields({ phoneId: "", token: "", secret: "" });
    setError(undefined);
    setMade(undefined);
  }, [open]);
  const set = (name: keyof typeof fields) => (event: { target: { value: string } }) =>
    setFields({ ...fields, [name]: event.target.value.trim() });
  const ready = /^\d{5,30}$/.test(fields.phoneId) && fields.token.length >= 20 &&
    fields.secret.length >= 16;
  const connect = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setMade(
        await call<Hook & { number: string }>("whatsapp.connect", {
          in: space,
          ...fields,
          url: globalThis.location?.origin,
        }),
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={made ? "Connected. One last step" : `Connect a WhatsApp number to ${where}`}
      description={made
        ? "Tell Meta where to send what people write to it."
        : "From your Meta app, with WhatsApp added to it."}
      footer={made ? <Button variant="primary" onClick={onClose}>Done</Button> : (
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void connect()}>
            Connect
          </Button>
        </>
      )}
    >
      {made ? <Webhook hook={made} /> : (
        <form
          className="wa-form"
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <ol className="wa-need">
            <li>
              In <a href={META} target="_blank" rel="noopener">your app</a>, under{" "}
              <b>WhatsApp → API Setup</b>: the number's <b>Phone number ID</b>.
            </li>
            <li>
              An <b>access token</b>{" "}
              that lasts: a system user's (Business settings → System users), with{" "}
              <code>whatsapp_business_messaging</code>. The temporary one on API Setup works for a
              day.
            </li>
            <li>
              In <b>App settings → Basic</b>: the <b>App secret</b>, which signs what Meta sends.
            </li>
          </ol>
          <Field label="Phone number ID" hint="Digits only: Meta's id for the number.">
            {(control) => (
              <Input
                {...control}
                value={fields.phoneId}
                onChange={set("phoneId")}
                inputMode="numeric"
                autoComplete="off"
                autoFocus
                placeholder="106540352242922"
              />
            )}
          </Field>
          <Field label="Access token" hint="Kept where nobody reads it back, not even you.">
            {(control) => (
              <Input
                {...control}
                type="password"
                value={fields.token}
                onChange={set("token")}
                autoComplete="off"
                placeholder="EAAG…"
              />
            )}
          </Field>
          <Field label="App secret">
            {(control) => (
              <Input
                {...control}
                type="password"
                value={fields.secret}
                onChange={set("secret")}
                autoComplete="off"
              />
            )}
          </Field>
          {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
          <button type="submit" hidden />
        </form>
      )}
    </Dialog>
  );
}

/** The webhook of a number already connected, for its managers. */
export function WebhookDialog(
  { number, onClose, call }: { number?: WhatsAppNumber; onClose(): void; call: Call },
): ReactNode {
  const [hook, setHook] = useState<Hook>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setHook(undefined);
    setError(undefined);
    if (number) {
      call<Hook>("whatsapp.webhook", { number: number._id }).then(
        setHook,
        (e) => setError(message(e)),
      );
    }
  }, [number?._id]);
  return (
    <Dialog
      open={!!number}
      onClose={onClose}
      size="lg"
      title="Webhook"
      description={number ? `Where Meta sends what people write to ${number.phone}.` : undefined}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : <Webhook hook={hook} />}
    </Dialog>
  );
}

/** A new access token (and, if it changed, the app's secret) for a number. */
export function ReplaceDialog(
  { number, onClose, call }: { number?: WhatsAppNumber; onClose(): void; call: Call },
): ReactNode {
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setToken("");
    setSecret("");
    setError(undefined);
  }, [number?._id]);
  const ready = token.trim().length >= 20 || secret.trim().length >= 16;
  const save = async () => {
    if (!number || !ready || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await call("whatsapp.credentials", {
        number: number._id,
        ...(token.trim() ? { token: token.trim() } : {}),
        ...(secret.trim() ? { secret: secret.trim() } : {}),
      });
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!number}
      onClose={onClose}
      title="Replace its credentials"
      description={number ? `For ${number.phone}. Leave one empty to keep it.` : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="wa-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field label="Access token" hint="Meta checks it before it's kept.">
          {(control) => (
            <Input
              {...control}
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="off"
              autoFocus
              placeholder="EAAG…"
            />
          )}
        </Field>
        <Field label="App secret">
          {(control) => (
            <Input
              {...control}
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              autoComplete="off"
            />
          )}
        </Field>
        {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/** Disconnecting a number, once they've read what it means. */
export function DisconnectDialog(
  { number, onClose, call }: { number?: WhatsAppNumber; onClose(): void; call: Call },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Dialog
      open={!!number}
      onClose={onClose}
      size="sm"
      title={number ? `Disconnect ${number.phone}?` : ""}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="destructive"
            loading={busy}
            onClick={async () => {
              if (!number) return;
              setBusy(true);
              setError(undefined);
              try {
                await call("whatsapp.disconnect", { number: number._id });
                onClose();
              } catch (e) {
                setError(message(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Disconnect
          </Button>
        </>
      }
    >
      <p className="wa-note">
        Messages to it stop reaching anyone's agents, and every phone linked to it is unlinked. The
        conversations people had stay where they are.
      </p>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
    </Dialog>
  );
}
