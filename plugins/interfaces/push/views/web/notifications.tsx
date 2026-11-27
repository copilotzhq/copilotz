/**
 * Notifications (`/notifications`, in the person's menu): turning them on
 * and off for this device, from a tap (browsers ask permission only then),
 * with why when it can't be (blocked, an iPhone outside the Home Screen, a
 * browser without push, an app without a key), and the person's devices
 * with them on, each one turned off from here.
 */
import { type ReactNode, useEffect, useState } from "react";
import {
  ago,
  Button,
  Icon,
  message,
  Notice,
  Page,
  type PushState,
  pushState,
  Skeleton,
  Switch,
  Title,
  turnPushOff,
  turnPushOn,
} from "../../../../../hosts/web/mod.ts";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import type { PushDevice } from "../../contract.ts";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

const STYLE = `
.push { display: grid; gap: 14px; }
.push-here { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 4px 16px;
  padding: 16px 18px; border: 1px solid var(--border); border-radius: var(--radius-xl); background: var(--card); }
.push-here h2, .push-heading { margin: 0; font-family: var(--font-display); font-size: 16px; font-weight: 650; }
.push-here p { grid-column: 1 / -1; margin: 0; color: var(--muted-foreground); font-size: 14px; line-height: 1.5; }
.push-heading { margin-top: 10px; }
.push-devices { list-style: none; display: grid; gap: 8px; margin: 0; padding: 0; }
.push-device { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px;
  padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--radius-lg); }
.push-device small { display: block; color: var(--muted-foreground); font-size: 13px; }
.push-quiet { margin: 0; color: var(--muted-foreground); font-size: 14px; }
`;

export const notificationsView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const devices = ctx.db.collection("pushSubscription").query<PushDevice[]>("mine", {}).value;
  const density = ctx.hints.mode === "panel" ? "panel" : "full";
  return (
    <Page title={say("title")} description={say("about")} icon="bell" density={density}>
      <Title text={say("title")} />
      <style href="push-web" precedence="copilotz">{STYLE}</style>
      <Notifications devices={devices} call={ctx.call} />
    </Page>
  );
};

export function Notifications(
  { devices, call }: { devices: PushDevice[] | undefined; call: Call },
): ReactNode {
  const [state, setState] = useState<PushState>();
  const [key, setKey] = useState<string | null>();
  const [here, setHere] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    void pushState().then(setState);
    void call<{ key: string | null }>("push.key", {}).then(
      (r) => setKey(r.key),
      () => setKey(null),
    );
  }, []);
  // Which of the list is this browser (the server never says an endpoint): what it was saved as.
  useEffect(() => {
    if (state !== "on") return setHere(undefined);
    void navigator.serviceWorker?.ready
      .then((r) => r.pushManager.getSubscription())
      .then(async (s) => s ? setHere(await idOf(s.endpoint)) : undefined)
      .catch(() => {});
  }, [state, devices?.length]);
  if (state === undefined || key === undefined) {
    return <Skeleton height={96} radius="xl" />;
  }
  const flip = async (on: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      setState(on ? await turnPushOn(key!, call) : await turnPushOff(call));
    } catch (e) {
      setError(message(e));
      setState(await pushState());
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setError(undefined);
    try {
      if (id === here) setState(await turnPushOff(call));
      else await call("push.unsubscribe", { id });
    } catch (e) {
      setError(message(e));
    }
  };
  const why = !key
    ? say("notSetUp")
    : state === "blocked"
    ? say("blocked")
    : state === "install"
    ? say("install")
    : state === "unsupported"
    ? say("unsupported")
    : undefined;
  return (
    <div className="push">
      <section className="push-here" aria-labelledby="push-here">
        <h2 id="push-here">{say("thisDevice")}</h2>
        {why ? null : (
          <Switch
            label={state === "on" ? say("turnOff") : say("turnOn")}
            checked={state === "on"}
            disabled={busy}
            onChange={(on) => void flip(on)}
          />
        )}
        <p>{why ?? (state === "on" ? say("onText") : say("offText"))}</p>
      </section>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      <h2 className="push-heading">{say("others")}</h2>
      {!devices?.length
        ? <p className="push-quiet">{say("othersEmpty")}</p>
        : (
          <ul className="push-devices">
            {devices.map((d) => {
              const name = d.device ?? say("thisOne");
              return (
                <li key={d.id} className="push-device">
                  <Icon name="bell" />
                  <span>
                    {name}
                    {d.id === here ? ` (${say("thisOne")})` : ""}
                    <small>{say("since", { when: ago(new Date(d.at)) })}</small>
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => void remove(d.id)}>
                    {say("turnOff")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
    </div>
  );
}

/** A subscription's id, as the server makes it (shared/settings.ts): the page tells this device apart. */
async function idOf(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest).subarray(0, 16)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}
