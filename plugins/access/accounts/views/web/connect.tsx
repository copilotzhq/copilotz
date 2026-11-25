/**
 * Connecting an account: in a dialog (`ConnectDialog`, the page's), or in
 * place (kind `accounts.connect`, item `{ provider }`: the connect flow's
 * line for a plan on the server). It starts the sign-in as it opens
 * (`account.connect`), so the link to it is a plain link: no popup to
 * block. What it allows comes first, said plainly.
 *
 * - **Pasted back** (ChatGPT): three steps. Sign in at the provider, in a
 *   new tab; it then opens a page that doesn't load (a command-line tool's
 *   address, as the steps show it), which is expected; paste that page's
 *   address here. A paste that is that address connects at once (as does
 *   the Paste button, which reads the clipboard); coming back to this tab
 *   puts the cursor in the field. A sign-in that ran out, or was replaced,
 *   starts again in a press.
 * - **Sent back** (most providers): one step, continuing to the provider,
 *   which sends the person back to Your AI, saying how it went.
 *
 * Connected, it says who the account is, and what happens now.
 */
import {
  type ClipboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
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

/** Connecting one account: its sign-in started, what was pasted, how it went. */
type Connect = ReturnType<typeof useConnecting>;

function useConnecting(provider: ProviderShown, open: boolean, call: Call) {
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
  return {
    provider,
    started,
    failed,
    opened,
    text,
    busy,
    problem,
    done,
    leaving,
    field,
    landing,
    looks: landing ? landed(text, landing) : "no" as const,
    start,
    finish,
    setText,
    setOpened,
    setProblem,
    leave() {
      if (!started) return;
      setLeaving(true);
      location.assign(started.url);
    },
  };
}

/** Its steps: starting, sent back (continue), pasted back (sign in, land, paste), connected. */
function ConnectSteps({ c, inline }: { c: Connect; inline?: boolean }): ReactNode {
  const title = sayText(c.provider.title);
  if (c.done) {
    return (
      <div role="status">
        <div className="accounts-done">
          <span className="accounts-done-icon">
            <Icon name="check" size={22} />
          </span>
          <div>
            <p className="accounts-done-title">{c.done.label}</p>
            <p className="accounts-done-who">
              {c.done.plan ? say("planOf", { provider: title, plan: c.done.plan }) : title}
            </p>
          </div>
        </div>
        <p className="accounts-done-next">
          {c.provider.models?.length
            ? say("nowRuns", { provider: title })
            : say("nowUses", { provider: title })}
          {c.landing ? ` ${say("closeTab")}` : ""}
        </p>
      </div>
    );
  }
  if (c.failed) {
    return (
      <Notice
        tone="destructive"
        role="alert"
        action={<Button size="sm" onClick={() => void c.start()}>{say("tryAgain")}</Button>}
      >
        {say("startFailed", { why: c.failed })}
      </Notice>
    );
  }
  if (!c.started) {
    return (
      <div className="accounts-steps" aria-busy="true">
        <Skeleton height={40} width="45%" radius="lg" />
        <Skeleton height={18} width="80%" />
      </div>
    );
  }
  const note = c.provider.note ? sayText(c.provider.note) : undefined;
  if (!c.landing) {
    return (
      <div className="accounts-steps">
        {note ? <p className="accounts-quiet">{note}</p> : null}
        <p className="accounts-say">{say("sentBack", { provider: title })}</p>
        {inline
          ? (
            <Button
              variant="primary"
              iconEnd="chevron"
              loading={c.leaving}
              className="accounts-sign-in"
              onClick={c.leave}
            >
              {say("continueTo", { provider: title })}
            </Button>
          )
          : null}
      </div>
    );
  }
  return (
    <PasteBack
      c={c}
      landing={c.landing}
      title={title}
      {...(note ? { note } : {})}
      {...(inline ? { inline } : {})}
    />
  );
}

/** Pasted back: sign in at the provider, land on a page that doesn't load, paste its address. */
function PasteBack(
  { c, landing, title, note, inline }: {
    c: Connect;
    landing: string;
    title: string;
    note?: string;
    inline?: boolean;
  },
): ReactNode {
  // Where the page may read what was copied (a secure page, in most browsers).
  const canPaste = typeof navigator.clipboard?.readText === "function";
  const pasted = (event: ClipboardEvent<HTMLInputElement>) => {
    const given = event.clipboardData.getData("text");
    if (landed(given, landing) === "yes") {
      event.preventDefault();
      c.setText(given.trim());
      void c.finish(given.trim());
    }
  };
  const fromClipboard = async () => {
    try {
      const given = (await navigator.clipboard.readText()).trim();
      c.setText(given);
      if (landed(given, landing) === "yes") void c.finish(given);
      else c.field.current?.focus();
    } catch {
      c.field.current?.focus();
      c.setProblem({ text: say("noClipboard") });
    }
  };
  return (
    <>
      {note ? <p className="accounts-quiet accounts-intro">{note}</p> : null}
      <ol className="accounts-steps">
        <li className={`accounts-step${c.opened ? " accounts-step-done" : ""}`}>
          <span className="accounts-step-number" aria-hidden="true">
            {c.opened ? <Icon name="check" size={14} /> : "1"}
          </span>
          <div className="accounts-step-body">
            <p>{say("stepSignIn", { provider: title })}</p>
            <Button
              className="accounts-sign-in"
              variant={c.opened ? "link" : "primary"}
              iconEnd="external"
              href={c.started!.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => c.setOpened(true)}
            >
              {c.opened ? say("signInAgain") : say("signInTo", { provider: title })}
            </Button>
          </div>
        </li>
        <li className={`accounts-step${c.opened ? "" : " accounts-step-later"}`}>
          <span className="accounts-step-number" aria-hidden="true">2</span>
          <div className="accounts-step-body">
            <p>{say.nodes("stepLand", { address: <code>{shortAddress(landing)}</code> })}</p>
          </div>
        </li>
        <li className={`accounts-step${c.opened ? "" : " accounts-step-later"}`}>
          <span className="accounts-step-number" aria-hidden="true">3</span>
          <div className="accounts-step-body">
            <Field
              label={say("pasteHere")}
              error={c.looks === "elsewhere"
                ? say("elsewhere", { address: shortAddress(landing) })
                : undefined}
              hint={c.looks === "no" && c.text.trim() ? say("notYet") : say("connectsOnPaste")}
            >
              {(control) => (
                <Input
                  {...control}
                  ref={c.field as RefObject<HTMLInputElement>}
                  value={c.text}
                  placeholder={`${landing}?code=…`}
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="off"
                  disabled={c.busy}
                  onChange={(event) => c.setText(event.currentTarget.value)}
                  onPaste={pasted}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && c.looks === "yes") void c.finish(c.text.trim());
                  }}
                  end={canPaste
                    ? (
                      <Button size="sm" variant="ghost" onClick={() => void fromClipboard()}>
                        {say("paste")}
                      </Button>
                    )
                    : null}
                />
              )}
            </Field>
            {inline
              ? (
                <Button
                  variant="primary"
                  className="accounts-sign-in"
                  loading={c.busy}
                  disabled={c.looks !== "yes"}
                  onClick={() => void c.finish(c.text.trim())}
                >
                  {say("connect")}
                </Button>
              )
              : null}
            {c.problem
              ? (
                <Notice
                  tone={c.problem.stale ? "warning" : "destructive"}
                  role="alert"
                  action={c.problem.stale
                    ? <Button size="sm" onClick={() => void c.start()}>{say("startAgain")}</Button>
                    : null}
                >
                  {c.problem.text}
                </Notice>
              )
              : null}
          </div>
        </li>
      </ol>
    </>
  );
}

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
  const c = useConnecting(provider, open, call);
  // Said as it opened: connecting doesn't make it a reconnect halfway through.
  const [reconnect] = useState(!!again);
  const title = sayText(provider.title);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size={c.done ? "sm" : "md"}
      title={c.done
        ? say("connectedTitle", { provider: title })
        : say(reconnect ? "reconnectTitle" : "connectTitle", { provider: title })}
      description={c.done ? undefined : sayText(provider.allows)}
      footer={c.done
        ? <Button variant="primary" onClick={onClose}>{say("done")}</Button>
        : c.landing
        ? (
          <>
            <Button onClick={onClose}>{say("cancel")}</Button>
            <Button
              variant="primary"
              loading={c.busy}
              disabled={c.looks !== "yes"}
              onClick={() => void c.finish(c.text.trim())}
            >
              {say(reconnect ? "reconnect" : "connect")}
            </Button>
          </>
        )
        : c.started && !c.failed
        ? (
          <>
            <Button onClick={onClose}>{say("cancel")}</Button>
            <Button variant="primary" iconEnd="chevron" loading={c.leaving} onClick={c.leave}>
              {say("continueTo", { provider: title })}
            </Button>
          </>
        )
        : <Button onClick={onClose}>{say("cancel")}</Button>}
    >
      <ConnectSteps c={c} />
    </Dialog>
  );
}

/** One account's connecting, in place (kind `accounts.connect`): the connect flow's line. */
export const accountsConnectView = (
  item: { provider?: string },
  ctx: ViewContext<ReactNode>,
): ReactNode => {
  const providers = ctx.db.collection("account").query<ProviderShown[]>("providers", {}).value;
  const provider = providers?.find((p) => p.name === item.provider);
  if (!provider) return providers ? null : <Skeleton height={40} radius="lg" />;
  return <InPlace provider={provider} call={ctx.call} />;
};

function InPlace({ provider, call }: { provider: ProviderShown; call: Call }): ReactNode {
  const c = useConnecting(provider, true, call);
  return (
    <div className="accounts-in-place">
      <style href="accounts-web" precedence="copilotz">{STYLE}</style>
      <p className="accounts-quiet">{sayText(provider.allows)}</p>
      <ConnectSteps c={c} inline />
    </div>
  );
}
