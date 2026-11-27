/** What the Notifications page says (`push.*`), the app's to change. */
import { defineWords } from "../../../../../hosts/web/words.ts";

export const say = defineWords("push", {
  title: "Notifications",
  about: "When something waits on you (an agent asking for your yes, a reply in a chat you " +
    "started, someone writing to you) and the app isn't open, we tell you on the devices " +
    "you turn them on for. Nothing while you're looking at the app.",
  thisDevice: "On this device",
  on: "On",
  off: "Off",
  turnOn: "Turn on",
  turnOff: "Turn off",
  onText: "You'll be told here when something waits on you.",
  offText: "Turn them on to be told here when something waits on you.",
  blocked: "Notifications are blocked for this app in your browser's settings. " +
    "Allow them there, then come back.",
  install: "On iPhone and iPad, notifications come only to the app on your Home Screen: " +
    "tap Share, then Add to Home Screen, open it from there and turn them on.",
  unsupported: "This browser can't show notifications from the app.",
  notSetUp: "Notifications aren't set up in this app yet.",
  others: "Your devices",
  othersEmpty: "No device has notifications on yet.",
  thisOne: "this device",
  since: "on since {when}",
  remove: "Turn off for {device}",
});
