/**
 * Inviting people into a shared space by email (`invitation.send`), as a
 * viewer, an editor or a manager: one address, or several at once (commas
 * or spaces between them). They join once they accept, signed in with that
 * email. What it says after never tells whether an address has an account
 * here ("Invited bob@example.com. They'll join once they accept."), and it's
 * ready for the next. In the Members tab, and in the invite dialog.
 */
import { type ReactNode, useId, useState } from "react";
import { Button, Icon, Input, message, Select } from "../../../../../hosts/web/mod.ts";
import type { Space } from "../../contract.ts";
import { addressesOf, EMAIL, invitedNote, ROLES } from "./who.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export function InviteForm(
  { space, call, compact, autoFocus }: {
    space: Pick<Space, "_id" | "name">;
    call: Call;
    compact?: boolean;
    autoFocus?: boolean;
  },
): ReactNode {
  const [typed, setTyped] = useState("");
  const [role, setRole] = useState("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const id = useId();
  const emails = addressesOf(typed);
  const ready = emails.length > 0 && emails.every((e) => EMAIL.test(e));
  const lets = ROLES.find((r) => r.value === role)?.lets;
  const size = compact ? "sm" : "md";
  return (
    <form
      className={`space-invite${compact ? " space-invite-compact" : ""}`}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!ready || busy) return;
        setBusy(true);
        setError(undefined);
        const sent: string[] = [];
        try {
          for (const email of emails) {
            await call("invitation.send", { space: space._id, email, role });
            sent.push(email);
          }
          setTyped("");
        } catch (e) {
          // Those sent are sent: what's left stays typed, to fix.
          setTyped(emails.filter((e) => !sent.includes(e)).join(", "));
          setError(message(e));
        } finally {
          setDone(sent.length ? invitedNote(sent) : undefined);
          setBusy(false);
        }
      }}
    >
      <div className="space-invite-row">
        <label className="copilotz-sr" htmlFor={`${id}-email`}>Their email</label>
        <Input
          id={`${id}-email`}
          type="text"
          inputMode="email"
          icon="mail"
          size={size}
          value={typed}
          maxLength={2000}
          placeholder="name@example.com"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus={autoFocus}
          invalid={!!error}
          aria-describedby={`${id}-note`}
          onChange={(event) => {
            setTyped(event.target.value);
            setDone(undefined);
            setError(undefined);
          }}
        />
        <label className="copilotz-sr" htmlFor={`${id}-role`}>Their role</label>
        <Select
          id={`${id}-role`}
          size={size}
          value={role}
          onChange={(event) => setRole(event.target.value)}
        >
          {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </Select>
        <Button
          type="submit"
          variant="primary"
          size={size}
          icon="invite"
          loading={busy}
          disabled={!ready}
        >
          Invite
        </Button>
      </div>
      <p id={`${id}-note`} className="space-invite-note" aria-live="polite">
        {error
          ? <span className="space-invite-error" role="alert">{error}</span>
          : done
          ? (
            <span className="space-invite-done">
              <Icon name="check" size={14} />
              {done}
            </span>
          )
          : (
            <span>
              {lets}. {emails.length > 1
                ? `${emails.length} addresses.`
                : "Several? Separate them with commas."}
            </span>
          )}
      </p>
    </form>
  );
}
