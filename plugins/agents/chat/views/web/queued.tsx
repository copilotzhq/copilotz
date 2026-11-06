/**
 * Under a message of yours that waits for its agents: each is still at work
 * on an earlier one in this chat, and answers this when it's done (it's
 * queued on the server, not lost). Quietly: "Goes to assistant when it's
 * done · Stop to send now", where Stop ends their turns (`chat.stop`, one
 * agent at a time) so this one is answered next.
 */
import { type ReactNode, useState } from "react";
import { Button, message } from "../../../../../hosts/web/mod.ts";
import { names } from "./who.ts";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export function Queued(
  { thread, agents, call }: {
    thread: string;
    /** The agents it waits for, by id, each with the name it shows as. */
    agents: { id: string; name: string }[];
    call: Call;
  },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <p className="msg-queued" role="status">
      {error ?? (
        <>
          {say("goesTo", { names: names(agents.map((a) => a.name)), count: agents.length })}
          <span aria-hidden="true">·</span>
          <Button
            variant="link"
            size="sm"
            className="msg-queued-stop"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(undefined);
              try {
                for (const a of agents) await call("chat.stop", { thread, agent: a.id });
              } catch (e) {
                setError(message(e));
                setBusy(false);
              }
            }}
          >
            {say("stopToSendNow")}
          </Button>
        </>
      )}
    </p>
  );
}
