/**
 * What you've let agents do without asking on this space's computers, with the
 * way to take each back (`computer.forgetGrant`): on the space's Computer tab,
 * only where there's something. What's let for a routine is on its own page.
 */
import { type ReactNode, useState } from "react";
import { Button, Card, Icon, message, Time } from "../../../../../hosts/web/mod.ts";
import type { Desk } from "../../collections/desk.ts";
import type { Grant } from "../../collections/grant.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

const DOING: Record<string, string> = {
  terminal: "run commands",
  jobs: "start jobs",
  writes: "change files",
  publish: "publish apps",
};

export function Allowed(
  { grants, desks, named, call }: {
    grants: Grant[];
    desks: Desk[];
    named(agent: string): string;
    call: Call;
  },
): ReactNode {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const shown = grants.filter((g) => !g.origin && !g.once && desks.some((d) => d._id === g.desk));
  if (!shown.length) return null;
  const forget = async (grant: string) => {
    setBusy(grant);
    setError(undefined);
    try {
      await call("computer.forgetGrant", { grant });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Card as="section" className="computer-allowed" aria-labelledby="computer-allowed">
      <h3 id="computer-allowed">
        <Icon name="lock" size={16} /> What you've let agents do without asking
      </h3>
      <ul>
        {shown.map((g) => {
          const desk = desks.find((d) => d._id === g.desk)!;
          return (
            <li key={g._id}>
              <span>
                <b>{named(g.agent)}</b> may {DOING[g.work] ?? g.work} on{" "}
                {desk.name ?? desk.computer}
                <small>
                  {g.thread ? "in one conversation" : "in any conversation"} ·{" "}
                  <Time at={g.at} long />
                </small>
              </span>
              <Button
                size="sm"
                variant="ghost"
                loading={busy === g._id}
                disabled={!!busy}
                onClick={() => void forget(g._id)}
              >
                Take back
              </Button>
            </li>
          );
        })}
      </ul>
      {error ? <p role="alert" className="ask-error">{error}</p> : null}
    </Card>
  );
}
