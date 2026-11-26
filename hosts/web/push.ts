/**
 * The page's side of push notifications (plugins/interfaces/push): whether
 * this browser can have them, and turning them on and off for it, with the
 * service worker the page registered (`/sw.js`, see pwa.ts).
 *
 * - `pushState()`: `"on"` (this browser is subscribed), `"off"`,
 *   `"blocked"` (the person said no: only the browser's settings undo it),
 *   `"install"` (an iPhone or iPad: only an app added to the Home Screen
 *   gets them, iOS 16.4 on) or `"unsupported"`.
 * - `turnPushOn(key, call)`, from a tap (browsers ask only then): asks
 *   permission, subscribes with the app's public key and saves the device
 *   (`push.subscribe`). `turnPushOff(call)` undoes both.
 */

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export type PushState = "on" | "off" | "blocked" | "install" | "unsupported";

const nav = () => globalThis.navigator as Navigator | undefined;

/** An iPhone or iPad (iPads say they're Macs, with a touch screen). */
const apple = () => {
  const n = nav();
  return !!n && (/iPhone|iPad|iPod/.test(n.userAgent) ||
    (/Macintosh/.test(n.userAgent) && (n.maxTouchPoints ?? 0) > 1));
};

/** Opened from the Home Screen, as an app. */
const installed = () =>
  globalThis.matchMedia?.("(display-mode: standalone)").matches ||
  (nav() as Navigator & { standalone?: boolean } | undefined)?.standalone === true;

const supported = () =>
  !!nav()?.serviceWorker && "PushManager" in globalThis && "Notification" in globalThis;

/** The worker's registration, once it's ready (or none, when the page has no worker). */
async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  const workers = nav()?.serviceWorker;
  if (!workers) return undefined;
  return await Promise.race([
    workers.ready,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
  ]);
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return apple() && !installed() ? "install" : "unsupported";
  if (Notification.permission === "denied") return "blocked";
  const found = await (await registration())?.pushManager.getSubscription();
  return found && Notification.permission === "granted" ? "on" : "off";
}

/** A word for this device, for the person's list: never more than the browser says. */
export function deviceName(agent = nav()?.userAgent ?? ""): string {
  if (/iPhone/.test(agent)) return "iPhone";
  if (/iPad/.test(agent) || (/Macintosh/.test(agent) && (nav()?.maxTouchPoints ?? 0) > 1)) {
    return "iPad";
  }
  if (/Android/.test(agent)) return "Android";
  if (/Macintosh|Mac OS X/.test(agent)) return "Mac";
  if (/Windows/.test(agent)) return "Windows";
  if (/CrOS/.test(agent)) return "Chromebook";
  if (/Linux/.test(agent)) return "Linux";
  return "This device";
}

/** A base64url key as the bytes `applicationServerKey` takes. */
export function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const b64 = key.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64 + "=".repeat((4 - b64.length % 4) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Turns notifications on for this browser: from a tap. Answers the state it's left in. */
export async function turnPushOn(key: string, call: Call): Promise<PushState> {
  if (!supported()) return await pushState();
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "blocked" : "off";
  const workers = await registration();
  if (!workers) {
    throw new Error("Notifications need the app's service worker, which isn't running.");
  }
  let subscription = await workers.pushManager.getSubscription();
  // One made with another key (the app's changed) can't be sent to: start again.
  const made = subscription?.options.applicationServerKey;
  if (subscription && made && !same(new Uint8Array(made), keyBytes(key))) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await workers.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(key),
  });
  await call("push.subscribe", { ...subscription.toJSON(), device: deviceName() });
  return "on";
}

/** Turns them off for this browser: the device leaves the person's list, and the browser forgets it. */
export async function turnPushOff(call: Call): Promise<PushState> {
  const subscription = await (await registration())?.pushManager.getSubscription();
  if (subscription) {
    await call("push.unsubscribe", { endpoint: subscription.endpoint }).catch(() => {});
    await subscription.unsubscribe().catch(() => false);
  }
  return await pushState();
}

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);
