/**
 * A cloud computer, as computers' pages show it (kind `cloud.computer`, the
 * computers' `computerKinds` View; item `{ _id }`, the computer), by
 * `hints.mode`:
 *
 * - `badge`: its state beside its name: Awake, Asleep, Sleeping deeply,
 *   Waking…, Going to sleep….
 * - `facts`: what it is in its page's header (its size, its disk), and,
 *   awake, for how long this time and about what that came to, at the price
 *   people pay; asleep, when it was last used.
 * - `asleep`: in place of its terminal, jobs and files while it's offline
 *   (item `{ _id, desk, name }`): that it's asleep (or deeply), and waking
 *   it (`computer.work` on its desk wakes it: the app's wake hook), at once
 *   when `hints.wake` (its page opened). While it wakes, how far along that
 *   looks, honestly: a few seconds, or about half a minute from cold, and
 *   when it's taking longer. Still waking when asked, it asks again.
 *
 * Live: its record (`cloudComputer.mine`) says each state as it changes.
 * Not one of the person's cloud computers, it shows nothing.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Badge,
  Button,
  Icon,
  message,
  Notice,
  Spinner,
  Time,
} from "../../../../../hosts/web/mod.ts";
import type { CloudComputer } from "../../contract.ts";
import {
  awakeFor,
  COLLECTION,
  costOf,
  duration,
  lookOf,
  money,
  type Offered,
  progress,
  type Sizes,
  sizesOf,
  specsOf,
  spent,
  stillWaking,
  WAKE_MS,
  WARM_MINUTES,
} from "./cloud.ts";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export const cloudComputerView = (
  item: { _id?: string; desk?: string; name?: string },
  ctx: ViewContext<ReactNode>,
): ReactNode => {
  const mode = ctx.hints.mode;
  const mine = ctx.db.collection(COLLECTION).query<CloudComputer[]>("mine", {}).value;
  // Its size's label and price, beyond the badge.
  const offered = mode === "badge"
    ? undefined
    : ctx.db.collection(COLLECTION).query<unknown>("sizes", {}).value;
  const record = mine?.find((r) => r._id === item._id);
  if (!record) return null;
  const sizes = sizesOf(offered);
  const size = sizes.sizes.find((s) => s.id === record.size);
  const style = <style href="cloud-web" precedence="copilotz">{STYLE}</style>;
  if (mode === "badge") {
    return (
      <>
        {style}
        <StateBadge state={record.state} />
      </>
    );
  }
  if (mode === "facts") {
    return (
      <>
        {style}
        <Facts record={record} size={size} />
      </>
    );
  }
  if (mode === "asleep") {
    return (
      <>
        {style}
        <Asleep
          key={record._id}
          record={record}
          size={size}
          sizes={sizes}
          name={item.name ?? "This computer"}
          {...(item.desk ? { desk: item.desk } : {})}
          wake={ctx.hints.wake === true}
          call={ctx.call}
        />
      </>
    );
  }
  return null;
};

/** Now, every `ms` while `on`. */
function useNow(on: boolean, ms: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [on, ms]);
  return now;
}

export function StateBadge({ state }: { state: CloudComputer["state"] }): ReactNode {
  const look = lookOf(state);
  return (
    <Badge tone={look.tone} className="cloud-state" data-state={state} title={look.hint}>
      {look.busy
        ? <Spinner size={9} className="cloud-state-spin" />
        : <span className="cloud-state-dot" aria-hidden="true" />}
      {look.label}
      {look.busy ? "…" : ""}
    </Badge>
  );
}

/** What it is, and while it's awake, for how long and about what it came to. */
function Facts({ record, size }: { record: CloudComputer; size?: Offered }): ReactNode {
  const awake = record.state === "awake";
  const now = useNow(awake, 30_000);
  const ms = awakeFor(record, now);
  const cost = ms === undefined ? undefined : costOf(ms, size?.hour ?? null);
  return (
    <>
      <span title={size ? `${specsOf(size)}${size.shared ? ", shared CPU" : ""}` : undefined}>
        <Icon name="server" size={14} />
        Cloud{size ? ` · ${size.label} (${specsOf(size)})` : ""}
      </span>
      <span>
        <Icon name="archive" size={14} />
        {record.diskGb} GB disk
      </span>
      {ms !== undefined
        ? (
          <span className="cloud-awake" title="Since it woke this time, at the price you pay">
            Awake for {duration(ms)}
            {cost !== undefined ? ` · ${spent(cost)} so far` : ""}
          </span>
        )
        : record.state === "asleep" || record.state === "cold"
        ? (
          <span>
            {record.used
              ? (
                <>
                  Last used <Time at={record.used} />
                </>
              )
              : "Not used yet"}
          </span>
        )
        : null}
    </>
  );
}

type Phase = "asleep" | "cold" | "waking" | "connecting" | "releasing";

/** Its phase, from its state and whether this page asked it to wake. */
const phaseOf = (state: CloudComputer["state"], asked: boolean): Phase =>
  state === "awake"
    ? "connecting"
    : state === "waking"
    ? "waking"
    : state === "releasing"
    ? "releasing"
    : asked
    ? "waking"
    : state;

/** Asleep, and waking it: what it means, then how the wake is going. */
function Asleep(
  { record, size, sizes, name, desk, wake, call }: {
    record: CloudComputer;
    size?: Offered;
    sizes: Sizes;
    name: string;
    desk?: string;
    wake: boolean;
    call: Call;
  },
): ReactNode {
  // When this page saw it start waking (asked here, or by anyone), and from how deep a sleep.
  const [since, setSince] = useState<number>();
  const [deep, setDeep] = useState(record.state === "cold");
  const [asked, setAsked] = useState(false);
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  const phase = phaseOf(record.state, asked && !error);
  const now = useNow(phase === "waking" || phase === "connecting", 250);

  // Waking, however it began: from now, for the progress.
  useEffect(() => {
    if (phase === "waking" && since === undefined) setSince(Date.now());
    if (phase === "asleep" || phase === "cold") setSince(undefined);
    if (record.state === "cold") setDeep(true);
  }, [phase, record.state]);

  const go = async () => {
    if (!desk) return;
    setError(undefined);
    setAsked(true);
    setDeep(record.state === "cold");
    setSince(Date.now());
    // Any work wakes it; still waking when asked, it's asked again in a moment.
    for (let tries = 0; tries < 8 && alive.current; tries++) {
      try {
        await call("computer.work", { desk, work: "jobs.list", input: { all: true } });
        return;
      } catch (e) {
        if (!stillWaking(e)) {
          if (alive.current) {
            setError(message(e));
            setAsked(false);
          }
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 4_000));
      }
    }
    if (alive.current) {
      setError("It didn't wake in time. Try again in a moment.");
      setAsked(false);
    }
  };
  // Its page opened: it wakes now.
  const once = useRef(false);
  useEffect(() => {
    if (!wake || once.current || !desk) return;
    if (record.state !== "asleep" && record.state !== "cold") return;
    once.current = true;
    void go();
  }, [wake, desk]);

  const expected = deep ? WAKE_MS.cold : WAKE_MS.asleep;
  const elapsed = since === undefined ? 0 : now - since;
  const slow = elapsed > expected * 2;
  const done = progress(elapsed, expected);
  const hour = size?.hour ?? null;
  const title = {
    asleep: `${name} is asleep`,
    cold: `${name} is sleeping deeply`,
    waking: `Waking ${name}…`,
    connecting: `${name} is connecting…`,
    releasing: `${name} is going to sleep`,
  }[phase];
  const text = {
    asleep: "It wakes when you or an agent uses it, in a few seconds. Its files and the jobs " +
      "it keeps running are as you left them.",
    cold: "It hasn't been used for a while, so its disk was put away. Waking it takes about " +
      "half a minute; everything on it is kept.",
    waking: slow
      ? "Taking longer than usual: still on it."
      : deep
      ? "Waking from deep sleep takes about half a minute."
      : "Usually a few seconds.",
    connecting: "It's awake: almost there.",
    releasing: "It's stopping its jobs and putting its disk away. It can wake again in a moment.",
  }[phase];
  return (
    <div className="cloud-asleep" data-phase={phase}>
      <span className="cloud-asleep-mark" aria-hidden="true">
        <Icon name="server" size={24} />
        <span className="cloud-asleep-ring" />
      </span>
      <div className="cloud-asleep-text" role="status" aria-live="polite">
        <h3>{title}</h3>
        <p>{text}</p>
      </div>
      {phase === "waking" || phase === "connecting"
        ? (
          <div className="cloud-wake">
            <div
              className="cloud-progress"
              role="progressbar"
              aria-label={`Waking ${name}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((phase === "connecting" ? 0.97 : done) * 100)}
              aria-valuetext={slow ? "Taking longer than usual" : "Waking"}
            >
              <span
                className="cloud-progress-bar"
                style={{ width: `${(phase === "connecting" ? 0.97 : done) * 100}%` }}
              />
            </div>
            <span className="cloud-wake-time">{Math.floor(elapsed / 1000)} s</span>
          </div>
        )
        : null}
      {error && (phase === "asleep" || phase === "cold")
        ? (
          <Notice
            tone="destructive"
            role="alert"
            className="cloud-asleep-error"
            action={<Button size="sm" icon="retry" onClick={() => void go()}>Try again</Button>}
          >
            {error}
          </Notice>
        )
        : null}
      {phase === "asleep" || phase === "cold" || phase === "releasing"
        ? (
          <Button
            variant="primary"
            icon="play"
            disabled={!desk || phase === "releasing"}
            onClick={() => void go()}
          >
            Wake it
          </Button>
        )
        : null}
      <p className="cloud-asleep-note">
        {hour !== null
          ? <>You pay while it's awake ({money(hour)} an hour).{" "}</>
          : "You pay while it's awake. "}
        It sleeps again after {WARM_MINUTES} minutes unused
        {sizes.disk.gbMonth !== null ? "; its disk is kept while it sleeps." : "."}
      </p>
    </div>
  );
}
