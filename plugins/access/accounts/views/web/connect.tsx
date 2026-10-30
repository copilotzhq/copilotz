/**
 * Connecting an account, in a dialog. It starts the sign-in as it opens
 * (`account.connect`), so the link to it is a plain link: no popup to
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
 *   which sends the person back to Connected accounts, saying how it went.
 *
 * Connected, it says who the account is, and what happens now.
 */
import { type ClipboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  Field,
  Icon,
  Input,
  message,
  Notice,
  Skeleton,
} from "../../../../../hosts/web/mod.ts";
import type { Account, Connecting, ProviderShown } from "../../contract.ts";
import { landed, shortAddress } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** Ways a sign-in can't be finished that only starting again mends. */
const STALE = /start again/;

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
  const [verb] = useState(again ? "Reconnect" : "Connect");

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
      setProblem({ text: "This browser didn't let the page read what you copied: paste it here." });
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size={done ? "sm" : "md"}
      title={done ? `${provider.title} is connected` : `${verb} ${provider.title}`}
      description={done ? undefined : provider.allows}
      footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : landing
        ? (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={looks !== "yes"}
              onClick={() => void finish(text.trim())}
            >
              {verb}
            </Button>
          </>
        )
        : started && !failed
        ? (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              iconEnd="chevron"
              loading={leaving}
              onClick={() => {
                setLeaving(true);
                location.assign(started.url);
              }}
            >
              Continue to {provider.title}
            </Button>
          </>
        )
        : <Button onClick={onClose}>Cancel</Button>}
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
                  {done.plan ? `${provider.title} ${done.plan} plan` : provider.title}
                </p>
              </div>
            </div>
            <p className="accounts-done-next">
              {provider.models?.length
                ? `Agents working for you now run on your ${provider.title} plan.`
                : `Agents working for you can now use your ${provider.title} account.`}
              {landing ? " You can close the sign-in tab." : ""}
            </p>
          </div>
        )
        : failed
        ? (
          <Notice
            tone="destructive"
            role="alert"
            action={<Button size="sm" onClick={() => void start()}>Try again</Button>}
          >
            Couldn't start connecting: {failed}
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
                  <p>Sign in to {provider.title} and allow access. It opens in a new tab.</p>
                  <Button
                    className="accounts-sign-in"
                    variant={opened ? "link" : "primary"}
                    iconEnd="external"
                    href={started.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setOpened(true)}
                  >
                    {opened ? "Open the sign-in again" : `Sign in to ${provider.title}`}
                  </Button>
                </div>
              </li>
              <li className={`accounts-step${opened ? "" : " accounts-step-later"}`}>
                <span className="accounts-step-number" aria-hidden="true">2</span>
                <div className="accounts-step-body">
                  <p>
                    You'll land on a page that doesn't load, at{" "}
                    <code>{shortAddress(landing)}</code>. That's expected. Copy that page's whole
                    address from the address bar.
                  </p>
                </div>
              </li>
              <li className={`accounts-step${opened ? "" : " accounts-step-later"}`}>
                <span className="accounts-step-number" aria-hidden="true">3</span>
                <div className="accounts-step-body">
                  <Field
                    label="Paste it here"
                    error={looks === "elsewhere"
                      ? `That's another page's address: it should start with ${
                        shortAddress(landing)
                      }`
                      : undefined}
                    hint={looks === "no" && text.trim()
                      ? "That doesn't look like it yet: copy the whole address, from the address bar"
                      : "It connects as soon as you paste it."}
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
                            <Button size="sm" variant="ghost" onClick={() => void fromClipboard()}>
                              Paste
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
                          ? <Button size="sm" onClick={() => void start()}>Start again</Button>
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
            {provider.note ? <p className="accounts-quiet">{provider.note}</p> : null}
            <p className="accounts-say">
              {provider.title} asks you to sign in and allow it, then sends you back here.
            </p>
          </div>
        )}
    </Dialog>
  );
}
