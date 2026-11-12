/**
 * A message's words sent on to another chat, as the person's own: a reply
 * an agent drafted in a chat's staff notes, for the contact the chat is
 * shared with. "Send to Ana…" opens a review right under the message, its
 * words ready to change, saying it goes as them and who'll read it; sent,
 * it says so, and shows in that chat as theirs. ⌘/Ctrl+Enter sends, Escape
 * puts it away.
 */
import { type ReactNode, useId, useRef, useState } from "react";
import { Button, Icon, message, Textarea } from "../../../../../hosts/web/mod.ts";
import { say } from "./words.ts";

/**
 * Where a message's words may be sent on (`web.message`'s `hints.sendTo`):
 * the chat, whom it's to there (`contact:<id>`), and how they're named.
 */
export type SendTo = { thread: string; to: string[]; name: string };

export function SendOn(
  { text, name, send, shown, children }: {
    /** What the message says: the draft, as it starts. */
    text: string;
    /** Who'll read it, as a sentence names them ("Ana"). */
    name: string;
    send(text: string): Promise<unknown>;
    /** Its button shows without a pointer over the message (an agent's answer: a draft). */
    shown?: boolean;
    /** What else the message offers beside it (copying it). */
    children?: ReactNode;
  },
): ReactNode {
  const [state, setState] = useState<"idle" | "review" | "sent">("idle");
  const [draft, setDraft] = useState(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const opener = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const id = useId();

  const open = () => {
    setDraft(text);
    setError(undefined);
    setState("review");
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(text.length, text.length);
    });
  };
  const cancel = () => {
    setState("idle");
    requestAnimationFrame(() => opener.current?.focus());
  };
  const submit = async () => {
    if (busy || !draft.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await send(draft.trim());
      setState("sent");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  if (state === "review") {
    return (
      <form
        className="msg-relay"
        aria-label={say("sendToNameNow", { name })}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="copilotz-sr" htmlFor={id}>{say("yourMessageTo", { name })}</label>
        <Textarea
          id={id}
          ref={field}
          rows={2}
          autoGrow
          className="msg-relay-text"
          value={draft}
          readOnly={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              cancel();
            } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <p className="msg-relay-note">
          <Icon name="eye" size={14} />
          <span>{say("sendsAsYou", { name })}</span>
        </p>
        {error ? <p role="alert" className="chat-error">{error}</p> : null}
        <div className="msg-relay-row">
          <Button size="sm" variant="ghost" onClick={cancel} disabled={busy}>
            {say("cancel")}
          </Button>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            icon="send"
            loading={busy}
            disabled={!draft.trim()}
          >
            {say("sendToNameNow", { name })}
          </Button>
        </div>
      </form>
    );
  }
  return (
    <div className={`msg-actions${shown ? " msg-actions-shown" : ""}`}>
      {children}
      {state === "sent"
        ? (
          <span className="msg-relayed" role="status">
            <Icon name="check" size={14} />
            {say("sentTo", { name })}
          </span>
        )
        : (
          <Button
            ref={opener}
            size="sm"
            variant="ghost"
            icon="send"
            className="msg-relay-open"
            onClick={open}
          >
            {say("sendToName", { name })}
          </Button>
        )}
    </div>
  );
}
