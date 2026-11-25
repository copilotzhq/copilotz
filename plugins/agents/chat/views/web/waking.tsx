/**
 * A model waiting for its computer to wake, in the agent's bubble
 * (`live.waking`): "Waking the computer… (about 5 seconds)", or longer at
 * this hour when the app says it's slower then; once that time has passed,
 * "Still waking the computer…". The computer, not "yours": everyone in the
 * conversation sees it. Calm, in the text's own colours.
 */
import { type ReactNode, useEffect, useState } from "react";
import { Spinner } from "../../../../../hosts/web/mod.ts";
import type { Live } from "../../collections/live.ts";
import { say } from "./words.ts";

export function Waking({ waking }: { waking: NonNullable<Live["waking"]> }): ReactNode {
  const due = waking.seconds === undefined
    ? undefined
    : Date.parse(waking.at) + waking.seconds * 1000;
  const [now, setNow] = useState(() => Date.now());
  const waiting = due !== undefined && now < due;
  // Once, when the time it was given is up.
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setNow(Date.now()), due! - Date.now());
    return () => clearTimeout(timer);
  }, [due, waiting]);
  return (
    <p className="live-waking" role="status">
      <Spinner size={12} className="live-retry-icon" />
      <span>
        {due === undefined
          ? say("waking")
          : waiting
          ? say(waking.slower ? "wakingSlower" : "wakingAbout", { count: waking.seconds! })
          : say("stillWaking")}
      </span>
    </p>
  );
}
