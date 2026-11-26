/**
 * Push notifications' shapes, for the plugins and front ends that use them:
 * the app's settings (`resources.push`), a device as its person sees it, and
 * a notification as it's sent.
 */

/**
 * The app's push settings (`resources.push`): its VAPID key pair (RFC 8292),
 * made once (`npx web-push generate-vapid-keys`, or `vapidKeys()`) and never
 * changed once people subscribe: every subscription is bound to the public
 * key, and a new pair silently ends them all. Both base64url: the public key
 * as its 65-byte point, the private as its 32-byte scalar. `contact` is how
 * the push services reach the app's people (`mailto:` or https). Without a
 * key, push is off: the page says so, and nothing is sent.
 */
export interface PushSettings {
  publicKey?: string;
  privateKey?: string;
  contact?: string;
}

/** A device with notifications on, as its person sees it (never its endpoint). */
export interface PushDevice {
  id: string;
  device?: string;
  at: string;
}

/** A notification: its title, its words, where tapping it goes, and a tag that folds repeats. */
export interface PushNotice {
  title: string;
  body?: string;
  /** A path in the app (`/chat/<thread>`); the app's start without one. */
  url?: string;
  /** Notifications with the same tag replace each other on the device: one per chat. */
  tag?: string;
}
