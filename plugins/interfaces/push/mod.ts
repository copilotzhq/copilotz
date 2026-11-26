/**
 * Push notifications (Web Push): the app reaches a person on their devices
 * when something waits on them, the app closed or out of sight.
 *
 * - **Devices** (`pushSubscription`): a person turns notifications on in
 *   each browser they want them in (`push.subscribe`, from a tap: browsers
 *   ask permission only then), and off (`push.unsubscribe`). Endpoints and
 *   keys are private; each person lists their own devices (`mine`), nobody
 *   else's, agents included.
 * - **The app's key** (`resources.push`, see contract.ts): a VAPID pair
 *   (RFC 8292), the app's own, made once and never changed once people
 *   subscribe. Without one, push is off and nothing is sent.
 * - **Sending** (`push.send`, the app's own code only): to each of a
 *   person's devices, encrypted for it (RFC 8291) and signed with the app's
 *   key (RFC 8292); a device its push service says is gone is forgotten.
 * - **The worker** (hosts/web/pwa.ts) shows what arrives, and a tap opens
 *   the app where the notification points, in a window already open when
 *   there is one.
 *
 * Its web front end is `pushWeb` (web.tsx): Notifications, in the person's
 * menu, where they turn them on for this device and see their others.
 *
 * ```ts
 * plugins: [...access, push, definePlugin({ name: "app", resources: {
 *   push: { publicKey: secrets.vapidPublic, privateKey: secrets.vapidPrivate, contact: "mailto:ops@example.com" },
 * } })]
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { sendAction } from "./actions/send.ts";
import { keyAction, subscribeAction, unsubscribeAction } from "./actions/subscribe.ts";
import { pushSubscription } from "./collections/subscription.ts";
import { rules } from "./shared/rules.ts";
import { settingsOf } from "./shared/settings.ts";

export * from "./contract.ts";
export { vapidKeys } from "./shared/webpush.ts";

export const push: Plugin = definePlugin({
  name: "push",
  collections: { pushSubscription },
  actions: {
    "push.subscribe": subscribeAction,
    "push.unsubscribe": unsubscribeAction,
    "push.key": keyAction,
    "push.send": sendAction,
  },
  guard: rules,
  resources: { push: {} },
  check(merged) {
    const { publicKey, privateKey, contact } = settingsOf(merged) as Record<string, unknown>;
    if (!publicKey !== !privateKey) {
      throw new Error("push: give both publicKey and privateKey (a VAPID pair), or neither");
    }
    if (publicKey && !/^(mailto:|https:\/\/)/.test(String(contact ?? ""))) {
      throw new Error("push: contact must be a mailto: or https:// address");
    }
  },
});

export default push;
