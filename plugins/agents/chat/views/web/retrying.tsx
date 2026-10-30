/**
 * A model's call that broke, in the agent's bubble while it's tried again
 * (`live.retry`): "Connection lost, retrying in 4 s", counting down, then
 * "Retrying…" once it's time; which retry it is, past the first; why, on
 * hover or focus. Calm, in the text's own colours: it usually comes back.
 * Screen readers hear it once, not every second.
 */
import { type ReactNode, useEffect, useState } from "react";
import { Icon, Spinner, Tooltip } from "../../../../../hosts/web/mod.ts";
import type { Live } from "../../collections/live.ts";

export function Retrying({ retry }: { retry: NonNullable<Live["retry"]> }): ReactNode {
  const due = Date.parse(retry.at);
  const [now, setNow] = useState(() => Date.now());
  const waiting = now < due;
  // A second at a time, until it's time (a new retry counts down again).
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [due, waiting]);
  const left = Math.max(1, Math.ceil((due - now) / 1000));
  return (
    <p className="live-retry">
      <span className="copilotz-sr" role="status">Connection lost. Trying again.</span>
      {waiting
        ? <Icon name="refresh" size={13} className="live-retry-icon" />
        : <Spinner size={12} className="live-retry-icon" />}
      <span aria-hidden="true">
        {waiting ? `Connection lost, retrying in ${left} s` : "Retrying…"}
      </span>
      {retry.attempt > 1
        ? <span className="live-retry-try" aria-hidden="true">retry {retry.attempt}</span>
        : null}
      <Tooltip text={retry.reason} describe={false}>
        <span className="live-retry-why" tabIndex={0} aria-label={`Why: ${retry.reason}`}>
          <Icon name="info" size={13} />
        </span>
      </Tooltip>
    </p>
  );
}
