/**
 * Why a computer shared with others' agents can't run the person's plan, and
 * how to change that: in the spaces where each person's agents work on it
 * as its owner, a sign-in there would be theirs to use too. Having its
 * agents ask the owner first there (`computer.share`, `answers: "owner"`,
 * as each computer's menu on a space's Computer tab does) makes it theirs
 * alone to answer for; taking it out of those spaces does too, from there.
 */
import { type ReactNode, useState } from "react";
import { Button, Dialog, Icon, message, Notice } from "../../../../../hosts/web/mod.ts";
import { listed, type Machine } from "./plans.ts";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** A space's Computer tab, where each computer's menu changes who answers there. */
const computerTab = (space: string) => `/space/${encodeURIComponent(space)}?tab=computer`;

export function SharedDialog(
  { machine: m, onClose, check, call }: {
    machine: Machine;
    onClose(): void;
    check(): Promise<void>;
    call: Call;
  },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const spaces = Array.isArray(m.shared) ? m.shared : [];
  const names = listed(spaces.map((s) => s.name));
  const askFirst = async () => {
    setBusy(true);
    setError(undefined);
    try {
      for (const space of spaces) {
        await call("computer.share", { computer: m.computer._id, in: space._id, answers: "owner" });
      }
      await check();
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={say("sharedTitle", { computer: m.name })}
      footer={spaces.length
        ? (
          <>
            <Button onClick={onClose}>{say("keepAsIs")}</Button>
            <Button variant="primary" icon="lock" loading={busy} onClick={() => void askFirst()}>
              {say("askMeFirst", { spaces: names })}
            </Button>
          </>
        )
        : <Button onClick={onClose}>{say("close")}</Button>}
    >
      <div className="plan-shared">
        <p>
          {spaces.length
            ? say("sharedWhy", { spaces: names, computer: m.name })
            : say("sharedWhySomewhere", { computer: m.name })}
        </p>
        {spaces.length ? <p>{say("sharedFix", { spaces: names })}</p> : null}
        {spaces.length
          ? (
            <ul className="plan-shared-spaces">
              {spaces.map((space) => (
                <li key={space._id}>
                  <a href={computerTab(space._id)}>
                    <Icon name="users" size={14} />
                    <span>{say("openSpace", { space: space.name })}</span>
                    <Icon name="chevron" size={14} />
                  </a>
                </li>
              ))}
            </ul>
          )
          : null}
        {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      </div>
    </Dialog>
  );
}
