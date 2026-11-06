/** The toolkit's words (buttons, times, players, the terminal): the app's to change (see ../words.ts). */
import { defineWords } from "../words.ts";

export const say = defineWords("toolkit", {
  // Dialogs, drawers, editing
  close: "Close",
  save: "Save",
  cancel: "Cancel",
  // Copying
  copy: "Copy",
  copied: "Copied",
  copyId: "Copy ID",
  copyCode: "Copy code",
  // Long text and code
  showMore: "Show more",
  showLess: "Show less",
  showEarlierLines: { one: "Show {count} earlier line", other: "Show {count} earlier lines" },
  showMoreLines: { one: "Show {count} more line", other: "Show {count} more lines" },
  // Details
  items: { one: "{count} item", other: "{count} items" },
  yes: "Yes",
  no: "No",
  when: "When",
  // Markdown
  table: "Table",
  done: "Done",
  toDo: "To do",
  // Math
  mathPending: "Still being written",
  mathLoading: "Loading math",
  // Audio
  audio: "Audio",
  audioLabel: "{label}, {length}",
  audioPosition: "{label}: position",
  audioProgress: "{at} of {length}",
  audioLengthUnknown: "unknown",
  audioFailed: "Couldn't load the {label}. Try again",
  audioLoading: "Loading",
  audioPause: "Pause",
  audioPlay: "Play",
  // Terminal
  terminal: "Terminal",
  terminalFailedTitle: "The terminal didn't load",
  terminalFailed: "Check your connection, then try again.",
  tryAgain: "Try again",
  terminalOpening: "Opening the terminal…",
  // Times: short, as a list says them
  now: "now",
  minutesShort: "{count}m",
  hoursShort: "{count}h",
  yesterday: "Yesterday",
  tomorrow: "Tomorrow",
  inMinutesShort: "in {count}m",
  inHoursShort: "in {count}h",
  // Times: long, as a sentence says them
  justNow: "just now",
  minutesAgo: { one: "{count} minute ago", other: "{count} minutes ago" },
  hoursAgo: { one: "{count} hour ago", other: "{count} hours ago" },
  inMinutes: { one: "in {count} minute", other: "in {count} minutes" },
  inHours: { one: "in {count} hour", other: "in {count} hours" },
});
