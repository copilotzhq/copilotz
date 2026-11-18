/**
 * The app's welcome, over home (the `welcome` resource's steps): a dialog
 * of steps, each its title, a line, and what its View shows, with Back and
 * Next, and Get started on the last. Each person sees it once, the first time
 * they come to home where it's there; closing it, or getting to the end,
 * counts (`chat.welcomed`). `/?welcome=1` shows it again. A step for some
 * roles shows only to people in the org with one of them, and one for some
 * kinds of org only there (spaces' `org.me`).
 */
import { type ReactNode, useState } from "react";
import { Button, Dialog, go } from "../../../../../hosts/web/mod.ts";
import { useStanding } from "../../../../interfaces/web/contract.ts";
import type { WelcomeStep } from "../../shared/types.ts";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** A step, with what its View shows. */
export type WelcomePart = WelcomeStep & { key: string; part: ReactNode };

export function Welcome(
  { steps, call, again, here }: {
    steps: WelcomePart[];
    call: Call;
    /** Asked for again (`?welcome=1`): closing it leaves the address for home's. */
    again: boolean;
    here?: string;
  },
): ReactNode {
  const roled = steps.some((step) => step.roles?.length || step.orgs?.length);
  const standing = useStanding(call, roled);
  const [open, setOpen] = useState(true);
  const [at, setAt] = useState(0);
  // Steps for some roles wait for the person's standing; until then, nothing shows.
  if (roled && !standing) return null;
  const kind = standing?.org?.kind;
  const mine = steps.filter((step) =>
    (!step.roles?.length || standing?.staff ||
      (!!standing?.role && step.roles.includes(standing.role))) &&
    (!step.orgs?.length || !kind || step.orgs.includes(kind))
  );
  if (!mine.length) return null;
  const step = mine[Math.min(at, mine.length - 1)];
  const last = at >= mine.length - 1;
  const close = () => {
    setOpen(false);
    void call("chat.welcomed", {}).catch(() => {});
    if (again) go(here ? `/?in=${encodeURIComponent(here)}` : "/");
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      size="lg"
      focus="dialog"
      className="chat-welcome"
      title={step.title}
      description={step.description}
      footer={
        <>
          {mine.length > 1
            ? (
              <span className="chat-welcome-count" aria-live="polite">
                {say("welcomeStep", { at: String(at + 1), count: String(mine.length) })}
              </span>
            )
            : null}
          {at > 0
            ? <Button variant="ghost" onClick={() => setAt(at - 1)}>{say("welcomeBack")}</Button>
            : null}
          {last
            ? <Button variant="primary" onClick={close}>{say("welcomeDone")}</Button>
            : (
              <Button variant="primary" onClick={() => setAt(at + 1)}>
                {say("welcomeNext")}
              </Button>
            )}
        </>
      }
    >
      <div className="chat-welcome-step" key={step.key}>{step.part}</div>
    </Dialog>
  );
}
