/**
 * A number as a customer line: open to anyone who writes to it, each in a
 * chat of their own in the number's space, answered by one of its agents.
 * Those who manage the space open and close it, choose who answers, and
 * after how long a quiet chat is over (the customer's next message starts
 * a new one). Everyone else is told it's open, and what that means.
 */
import { type ReactNode, useState } from "react";
import { Button, Icon, message, Notice, Select } from "../../../../../hosts/web/mod.ts";
import type { Agent } from "../../../../agents/chat/contract.ts";
import { GAP, type WhatsAppNumber } from "../../contract.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** How long a quiet chat lasts, as managers choose it, in hours. */
const GAPS = [4, 8, 12, 24, 48, 72];

const hours = (n: number) => n % 24 === 0 ? `${n / 24} ${n === 24 ? "day" : "days"}` : `${n} hours`;

export function CustomerLine(
  { number, where, manage, here, agents, fallback, call }: {
    number: WhatsAppNumber;
    /** The space's name, as people read it. */
    where: string;
    manage: boolean;
    /** The agents answering in the space, and what each is. */
    here: string[];
    agents: Record<string, Agent>;
    /** Who answers the space's new chats, when the number names nobody. */
    fallback?: string;
    call: Call;
  },
): ReactNode {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const set = async (what: string, input: Record<string, unknown>) => {
    setBusy(what);
    setError(undefined);
    try {
      await call("whatsapp.set", { number: number._id, ...input });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  };
  const named = (name: string) => agents[name]?.name ?? name;
  const failed = error ? <Notice tone="destructive" role="alert">{error}</Notice> : null;
  const gap = number.gap ?? GAP;

  if (!manage) {
    if (!number.open) return null;
    return (
      <div className="wa-line">
        <div className="wa-line-head">
          <Icon name="users" size={18} />
          <b>Open to customers</b>
        </div>
        <p className="wa-note">
          Anyone can write to this number. Each person gets a chat of their own in{" "}
          {where}, answered by{" "}
          {named(number.agent ?? fallback ?? "its agent")}; they see only that chat.
        </p>
      </div>
    );
  }

  if (!number.open) {
    return (
      <div className="wa-line">
        <div className="wa-offer">
          <div className="wa-offer-text">
            <b>Open it to customers</b>
            <span className="wa-note">
              Anyone who writes gets a chat of their own in{" "}
              {where}, answered by an agent. They see only that chat; everyone in {where}{" "}
              can read it.
            </span>
          </div>
          <Button
            icon="users"
            loading={busy === "open"}
            disabled={!here.length}
            onClick={() => set("open", { open: true })}
          >
            Open to customers
          </Button>
        </div>
        {here.length ? null : (
          <p className="wa-note">
            No agent answers in {where} yet: add one as an editor under Members first.
          </p>
        )}
        {failed}
      </div>
    );
  }

  const answering = number.agent && here.includes(number.agent) ? number.agent : "";
  return (
    <div className="wa-line">
      <div className="wa-line-head">
        <Icon name="users" size={18} />
        <b>Open to customers</b>
      </div>
      <p className="wa-note">
        Anyone can write to this number. Each person gets a chat of their own in{" "}
        {where}'s chats; they see only that chat.
      </p>
      <div className="wa-line-fields">
        <div className="wa-where">
          <label htmlFor={`wa-agent-${number._id}`}>Answered by</label>
          <Select
            id={`wa-agent-${number._id}`}
            value={answering}
            disabled={busy === "agent"}
            onChange={(event) => void set("agent", { agent: event.target.value || null })}
          >
            <option value="">
              {fallback ? `${named(fallback)}, who answers new chats here` : "Who answers here"}
            </option>
            {here.map((name) => <option key={name} value={name}>{named(name)}</option>)}
          </Select>
        </div>
        <div className="wa-where">
          <label htmlFor={`wa-gap-${number._id}`}>New chat after</label>
          <Select
            id={`wa-gap-${number._id}`}
            value={String(gap)}
            disabled={busy === "gap"}
            onChange={(event) => void set("gap", { gap: Number(event.target.value) })}
          >
            {[...new Set([...GAPS, gap])].sort((a, b) => a - b).map((n) => (
              <option key={n} value={String(n)}>
                {hours(n)} of quiet{n === GAP ? " (default)" : ""}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {failed}
      <div className="wa-actions">
        <Button
          variant="ghost"
          loading={busy === "close"}
          onClick={() => set("close", { open: false })}
        >
          Close to customers
        </Button>
      </div>
    </div>
  );
}
