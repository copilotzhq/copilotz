/// <reference lib="dom" />
/**
 * Your phone and a number: linking it (a code to send from WhatsApp, with a
 * link that opens WhatsApp with it typed in, and how long it has left; it
 * flips to linked the moment the message arrives, as the person's phones
 * and codes are live), then, linked, where your messages go (a space you
 * may write in), what you can type there, and unlinking it.
 */
import { type ReactNode, useEffect, useState } from "react";
import {
  Button,
  clock,
  CopyButton,
  Icon,
  message,
  Notice,
  Select,
  Spinner,
  Time,
} from "../../../../../hosts/web/mod.ts";
import type { WhatsAppCode, WhatsAppNumber, WhatsAppPhone } from "../../contract.ts";
import { chatLink, grouped, shown } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** A space their messages may go to. */
export type Place = { _id: string; name: string };

/** Now, every second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

export function YourPhone(
  { number, phone, code, places, personal, call }: {
    number: WhatsAppNumber;
    phone?: WhatsAppPhone;
    code?: WhatsAppCode;
    /** Where their messages may go, Personal first. */
    places: Place[];
    personal?: string;
    call: Call;
  },
): ReactNode {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const now = useNow(!!code && !phone);
  const act = async (what: string, run: () => Promise<unknown>) => {
    setBusy(what);
    setError(undefined);
    try {
      await run();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  };
  const link = () => act("link", () => call("whatsapp.link", { number: number._id }));
  const failed = error ? <Notice tone="destructive" role="alert">{error}</Notice> : null;

  if (phone) {
    const here = phone.space ?? personal ?? "";
    return (
      <div className="wa-linked">
        <div className="wa-linked-head">
          <Icon name="check-circle" size={18} />
          <b>Your phone is linked</b>
          <span className="wa-linked-phone">
            {shown(phone.phone)}
            {phone.linked
              ? (
                <>
                  {" · linked "}
                  <Time at={phone.linked} />
                </>
              )
              : null}
          </span>
        </div>
        <div className="wa-where">
          <label htmlFor={`wa-where-${number._id}`}>Your messages go to</label>
          <Select
            id={`wa-where-${number._id}`}
            value={here}
            disabled={busy === "move"}
            onChange={(event) => {
              const space = event.target.value;
              void act("move", () => call("whatsapp.move", { number: number._id, space }));
            }}
          >
            {places.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
          </Select>
        </div>
        <p className="wa-tips">
          Write to <b>{number.phone}</b>. Photos, documents and voice notes reach your agents too.
          {" "}
          <code>/new</code> starts a new conversation, <code>/space</code> changes where you talk,
          {" "}
          <code>/help</code> says the rest.
        </p>
        {failed}
        <div className="wa-actions">
          <Button
            variant="primary"
            iconEnd="external"
            href={chatLink(number.phone)}
            target="_blank"
            rel="noopener"
          >
            Open WhatsApp
          </Button>
          <Button
            variant="ghost"
            loading={busy === "unlink"}
            onClick={() => act("unlink", () => call("whatsapp.unlink", { number: number._id }))}
          >
            Unlink
          </Button>
        </div>
      </div>
    );
  }

  if (code) {
    const left = Math.max(0, Date.parse(code.expires) - now);
    const spent = left <= 0;
    return (
      <>
        <ol className="wa-steps">
          <li>
            <span className="wa-step-number" aria-hidden="true">1</span>
            <div className="wa-step">
              <p>
                From the phone you want to link, send this code to <b>{number.phone}</b>{" "}
                on WhatsApp:
              </p>
              <div className="wa-code" data-spent={spent || undefined}>
                <span className="wa-code-digits" aria-label={code.code.split("").join(" ")}>
                  {grouped(code.code)}
                </span>
                {spent ? null : <CopyButton text={code.code} label="Copy the code" />}
              </div>
              {spent
                ? (
                  <p className="wa-expiry" aria-live="polite">
                    <span>This code has run out.</span>
                    <Button size="sm" icon="refresh" loading={busy === "link"} onClick={link}>
                      New code
                    </Button>
                  </p>
                )
                : (
                  <>
                    <div className="wa-actions">
                      <Button
                        variant="primary"
                        iconEnd="external"
                        href={chatLink(number.phone, code.code)}
                        target="_blank"
                        rel="noopener"
                      >
                        Send it from WhatsApp
                      </Button>
                    </div>
                    <p className="wa-expiry">
                      <Icon name="lock" size={13} />
                      <span>
                        Works once, for <b className="wa-left">{clock(left)}</b> more
                      </span>
                    </p>
                  </>
                )}
            </div>
          </li>
          <li>
            <span className="wa-step-number" aria-hidden="true">2</span>
            <div className="wa-step">
              <p>That's all: this changes the moment it arrives.</p>
              {spent ? null : (
                <p className="wa-waiting" role="status">
                  <Spinner variant="dots" size={5} />
                  Waiting for your message…
                </p>
              )}
            </div>
          </li>
        </ol>
        {failed}
      </>
    );
  }

  return (
    <>
      <div className="wa-offer">
        <div className="wa-offer-text">
          <b>Message your agents from WhatsApp</b>
          <span className="wa-note">
            Link your phone once, by sending {number.phone} a code from it.
          </span>
        </div>
        <Button variant="primary" loading={busy === "link"} onClick={link}>
          Link my phone
        </Button>
      </div>
      {failed}
    </>
  );
}
