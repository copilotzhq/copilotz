/**
 * An agent's step: what it said first, if anything, then the tools it
 * called. A call whose tool has a View of its own (`shown`, from the
 * `toolViews` resource) shows as that View, in order; the others fold to a
 * line ("Used clock, roll_dice"), and open, each with what it was given and
 * what it returned.
 */
import type { ReactNode } from "react";
import { Card, Chip, Icon, Markdown } from "../../../../../hosts/web/mod.ts";
import type { Step } from "../../shared/types.ts";

type Call = { name: string; input?: Record<string, unknown> };

/** Whom a call sent a message to, if it sent one. */
const sentTo = (c: Call) =>
  c.name === "send_message" && typeof c.input?.to === "string" ? c.input.to : undefined;

/**
 * What calls did, in a few words: "Messaged Maya · Used clock, roll_dice";
 * running, "Using…". The viewer (`me`) is "you"; agents, as they're
 * `named`.
 */
export function did(
  calls: Call[],
  running = false,
  me?: string,
  named: (id: string) => string = (id) => id,
): ReactNode {
  const to = [...new Set(calls.flatMap((c) => sentTo(c) ?? []))]
    .map((name) => name === me ? "you" : named(name));
  const used = [...new Set(calls.filter((c) => !sentTo(c)).map((c) => c.name))];
  return (
    <>
      {to.length
        ? (
          <>
            {running ? "Messaging" : "Messaged"} <b className="step-who">{to.join(", ")}</b>
          </>
        )
        : null}
      {to.length && used.length ? " · " : null}
      {used.length
        ? (
          <>
            {running ? "Using" : "Used"} <b>{used.join(", ")}</b>
          </>
        )
        : null}
    </>
  );
}

const pretty = (value: unknown) => {
  if (typeof value !== "string") return JSON.stringify(value ?? {}, null, 2);
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
};

export function Steps(
  { calls, text, me, named, shown = [] }: {
    calls: Step[];
    text?: string;
    me?: string;
    /** How an agent messaged is named. */
    named?(id: string): string;
    /** Each call as its tool's View shows it, where it has one. */
    shown?: (ReactNode | undefined)[];
  },
): ReactNode {
  const own = calls.flatMap((c, i) => shown[i] === undefined ? [] : [{ c, view: shown[i] }]);
  const rest = calls.filter((_, i) => shown[i] === undefined);
  return (
    <div className="msg-step">
      {text ? <Markdown text={text} /> : null}
      {own.length
        ? <div className="step-shown">{own.map(({ c, view }) => <div key={c.id}>{view}</div>)}</div>
        : null}
      {rest.length ? <Calls calls={rest} me={me} named={named} /> : null}
    </div>
  );
}

/** Calls as data, folded to a line. */
function Calls(
  { calls, me, named }: { calls: Step[]; me?: string; named?(id: string): string },
): ReactNode {
  return (
    <details className="step">
      <Chip as="summary" variant="outline" icon="tool" className="step-summary">
        <span className="step-what">{did(calls, false, me, named)}</span>
        <span className="step-chevron">
          <Icon name="chevron" size={14} />
        </span>
      </Chip>
      <div className="step-calls">
        {calls.map((c) => (
          <Card key={c.id} as="section" padding="none" className="step-call" aria-label={c.name}>
            <header>{c.name}</header>
            {c.input && Object.keys(c.input).length
              ? (
                <div className="step-io">
                  <span>Input</span>
                  <pre>{pretty(c.input)}</pre>
                </div>
              )
              : null}
            <div className="step-io">
              <span>Result</span>
              <pre>{pretty(c.output)}</pre>
            </div>
          </Card>
        ))}
      </div>
    </details>
  );
}
