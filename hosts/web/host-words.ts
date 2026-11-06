/** The web host's own words (loading, failures, a new version): the app's to change (see ./words.ts). */
import { defineWords } from "./words.ts";

export const say = defineWords("host", {
  // A part loading or failed
  loading: "Loading",
  forbiddenTitle: "You can't see this here",
  forbidden: "It isn't shared with you, or it only shows inside another page.",
  failedTitle: "Something went wrong here",
  reload: "Reload",
  // A new version
  newVersion: "A new version of {app} is ready",
  newVersionHint: "Reload to use it; nothing you've done is lost.",
  later: "Later",
  // Coming in and connecting
  couldntComeIn: "Couldn't come in",
  couldntConnect: "Couldn't connect",
  signedOut: "Signed out",
  // Inside an assistant's widget
  noHost: "No host",
  hostSilent: "The host didn't answer",
  widgetCantCall: "This widget can't call its app here",
  couldntRead: "Couldn't read",
  notOffered: "{action} isn't offered in this widget",
});
