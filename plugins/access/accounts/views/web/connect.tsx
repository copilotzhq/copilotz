/**
 * Connecting an account, in a dialog: the page's (`ConnectDialog`), and the
 * connect flow's line for a plan on the server (kind `accounts.connect`,
 * item `{ provider }`: a button that opens it). It starts the sign-in as it
 * opens (`account.connect`), so the link to it is a plain link: no popup to
 * block. What it allows comes first, said plainly.
 *
 * - **Pasted back** (ChatGPT): three steps. Sign in at the provider, in a
 *   new tab; it then opens a page that doesn't load (a command-line tool's
 *   address, as the dialog shows it), which is expected; paste that page's
 *   address here. A paste that is that address connects at once (as does
 *   the Paste button, which reads the clipboard); coming back to this tab
 *   puts the cursor in the field. A sign-in that ran out, or was replaced,
 *   starts again in a press.
 * - **Sent back** (most providers): one step, continuing to the provider,
 *   which sends the person back to Your AI, saying how it went.
 *
 * Connected, it says who the account is, and what happens now.
 */
import { type ClipboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Button,
  Dialog,
  Field,
  Icon,
  Input,
  message,
  Notice,
  sayText,
  Skeleton,
} from "../../../../../hosts/web/mod.ts";
import type { Account, Connecting, ProviderShown } from "../../contract.ts";
import { STYLE } from "./style.ts";
import { landed, say, shortAddress } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** Ways a sign-in can't be finished that only starting again mends. */
const STALE = /start again/;

/** Connecting one account, in a dialog. */
export function ConnectDialog(
  { provider, open, onClose, call, again }: {
    provider: ProviderShown;
    open: boolean;
    onClose(): void;
    call: Call;
    /** Connecting again an account that needs it. */
    again?: boolean;
  },
): ReactNode {
  const [started, setStarted] = useState<Connecting>();
  const [failed, setFailed] = useState<string>();
  const [opened, setOpened] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; stale?: boolean }>();
  const [done, setDone] = useState<Account>();
  /** On its way to the provider (this tab goes there). */
  const [leaving, setLeaving] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  // Said as it opened: connecting doesn't make it a reconnect halfway through.
  const [reconnect] = useState(!!again);
  const title = sayText(provider.title);

  const start = async () => {
    setStarted(undefined);
    setFailed(undefined);
    setProblem(undefined);
    setText("");
    setOpened(false);
    try {
      setStarted(
        await call<Connecting>("account.connect", {
          provider: provider.name,
          origin: location.origin,
        }),
      );
    } catch (error) {
      setFailed(message(error));
    }
  };
  useEffect(() => {
    if (open) void start();
    else setDone(undefined);
  }, [open]);

  // Back from signing in: ready to paste.
  useEffect(() => {
    if (!open || !opened) return;
    const back = () => field.current?.focus();
    addEventListener("focus", back);
    return () => removeEventListener("focus", back);
  }, [open, opened]);

  const finish = async (address: string) => {
    if (busy) return;
    setBusy(true);
    setProblem(undefined);
    try {
      setDone(await call<Account>("account.complete", { provider: provider.name, address }));
    } catch (error) {
      const said = message(error);
      setProblem({ text: said, stale: STALE.test(said) });
    } finally {
      setBusy(false);
    }
  };

  const landing = started?.paste;
  // Where the page may read what was copied (a secure page, in most browsers).
  const canPaste = typeof navigator.clipboard?.readText === "function";
  const looks = landing ? landed(text, landing) : "no";
  const pasted = (event: ClipboardEvent<HTMLInputElement>) => {
    const given = event.clipboardData.getData("text");
    if (landing && landed(given, landing) === "yes") {
      event.preventDefault();
      setText(given.trim());
      void finish(given.trim());
    }
  };
  const fromClipboard = async () => {
    try {
      const given = (await navigator.clipboard.readText()).trim();
      setText(given);
      if (landing && landed(given, landing) === "yes") void finish(given);
      else field.current?.focus();
    } catch {
      field.current?.focus();
      setProblem({ text: say("noClipboard") });
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size={done ? "sm" : "md"}
      title={done
        ? say("connectedTitle", { provider: title })
        : say(reconnect ? "reconnectTitle" : "connectTitle", { provider: title })}
      description={done ? undefined : sayText(provider.allows)}
      footer={done ? <Button variant="primary" onClick={onClose}>{say("done")}</Button> : landing
        ? (
          <>
            <Button onClick={onClose}>{say("cancel")}</Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={looks !== "yes"}
              onClick={() => void finish(text.trim())}
            >
              {say(reconnect ? "reconnect" : "connect")}
            </Button>
          </>
        )
        : started && !failed
        ? (
          <>
            <Button onClick={onClose}>{say("cancel")}</Button>
            <Button
              variant="primary"
              iconEnd="chevron"
              loading={leaving}
              onClick={() => {
                setLeaving(true);
                location.assign(started.url);
              }}
            >
              {say("continueTo", { provider: title })}
            </Button>
          </>
        )
        : <Button onClick={onClose}>{say("cancel")}</Button>}
    >
      {done
        ? (
          <div role="status">
            <div className="accounts-done">
              <span className="accounts-done-icon">
                <Icon name="check" size={22} />
              </span>
              <div>
                <p className="accounts-done-title">{done.label}</p>
                <p className="accounts-done-who">
                  {done.plan ? say("planOf", { provider: title, plan: done.plan }) : title}
                </p>
              </div>
            </div>
            <p className="accounts-done-next">
              {provider.models?.length
                ? say("nowRuns", { provider: title })
                : say("nowUses", { provider: title })}
              {landing ? ` ${say("closeTab")}` : ""}
            </p>
          </div>
        )
        : failed
        ? (
          <Notice
            tone="destructive"
            role="alert"
            action={<Button size="sm" onClick={() => void start()}>{say("tryAgain")}</Button>}
          >
            {say("startFailed", { why: failed })}
          </Notice>
        )
        : !started
        ? (
          <div className="accounts-steps" aria-busy="true">
            <Skeleton height={40} width="45%" radius="lg" />
            <Skeleton height={18} width="80%" />
          </div>
        )
        : landing
        ? (
          <>
            {provider.note
              ? <p className="accounts-quiet accounts-intro">{provider.note}</p>
              : null}
            <ol className="accounts-steps">
              <li className={`accounts-step${opened ? " accounts-step-done" : ""}`}>
                <span className="accounts-step-number" aria-hidden="true">
                  {opened ? <Icon name="check" size={14} /> : "1"}
                </span>
                <div className="accounts-step-body">
                  <p>{say("stepSignIn", { provider: title })}</p>
                  <Button
                    className="accounts-sign-in"
                    variant={opened ? "link" : "primary"}
                    iconEnd="external"
                    href={started.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setOpened(true)}
                  >
                    {opened ? say("signInAgain") : say("signInTo", { provider: title })}
                  </Button>
                </div>
              </li>
              <li className={`accounts-step${opened ? "" : " accounts-step-later"}`}>
                <span className="accounts-step-number" aria-hidden="true">2</span>
                <div className="accounts-step-body">
                  <p>{say.nodes("stepLand", { address: <code>{shortAddress(landing)}</code> })}</p>
                </div>
              </li>
              <li className={`accounts-step${opened ? "" : " accounts-step-later"}`}>
                <span className="accounts-step-number" aria-hidden="true">3</span>
                <div className="accounts-step-body">
                  <Field
                    label={say("pasteHere")}
                    error={looks === "elsewhere"
                      ? say("elsewhere", { address: shortAddress(landing) })
                      : undefined}
                    hint={looks === "no" && text.trim() ? say("notYet") : say("connectsOnPaste")}
                  >
                    {(control) => (
                      <Input
                        {...control}
                        ref={field}
                        value={text}
                        placeholder={`${landing}?code=…`}
                        spellCheck={false}
                        autoComplete="off"
                        autoCapitalize="off"
                        disabled={busy}
                        onChange={(event) => setText(event.currentTarget.value)}
                        onPaste={pasted}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && looks === "yes") void finish(text.trim());
                        }}
                        end={canPaste
                          ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void fromClipboard()}
                            >
                              {say("paste")}
                            </Button>
                          )
                          : null}
                      />
                    )}
                  </Field>
                  {problem
                    ? (
                      <Notice
                        tone={problem.stale ? "warning" : "destructive"}
                        role="alert"
                        action={problem.stale
                          ? (
                            <Button size="sm" onClick={() => void start()}>
                              {say("startAgain")}
                            </Button>
                          )
                          : null}
                      >
                        {problem.text}
                      </Notice>
                    )
                    : null}
                </div>
              </li>
            </ol>
          </>
        )
        : (
          <div className="accounts-steps">
            {provider.note ? <p className="accounts-quiet">{sayText(provider.note)}</p> : null}
            <p className="accounts-say">{say("sentBack", { provider: title })}</p>
          </div>
        )}
    </Dialog>
  );
}

/**
 * One account to connect, for the connect flow's line of a plan on the
 * server (kind `accounts.connect`, item `{ provider }`): a button that opens
 * its dialog. The flow ticks once the account's connected.
 */
export const accountsConnectView = (
  item: { provider?: string },
  ctx: ViewContext<ReactNode>,
): ReactNode => {
  const providers = ctx.db.collection("account").query<ProviderShown[]>("providers", {}).value;
  const provider = providers?.find((p) => p.name === item.provider);
  return provider ? <ConnectButton provider={provider} call={ctx.call} /> : null;
};

function ConnectButton({ provider, call }: { provider: ProviderShown; call: Call }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <>
      <style href="accounts-web" precedence="copilotz">{STYLE}</style>
      <Button variant="primary" className="accounts-sign-in" onClick={() => setOpen(true)}>
        {say("connectTitle", { provider: sayText(provider.title) })}
      </Button>
      {open
        ? <ConnectDialog provider={provider} open onClose={() => setOpen(false)} call={call} />
        : null}
    </>
  );
}
