/**
 * The words of computers' web front end, in English: so far, a person's
 * plans on their own computers (on Connected accounts, its sign-in dialog,
 * and the palette's), a computer's Files tab (its folders, uploading to
 * them, why an upload didn't go), and an agent's calls that move a file
 * between a chat and a computer. An app gives its own under
 * `computers.<key>`. The plans' names are the providers'
 * (resources/engines.ts): "Claude plan", "ChatGPT plan, through Codex",
 * "Google AI plan, through Antigravity".
 */
import { defineWords } from "../../../../../hosts/web/words.ts";

export const say = defineWords("computers", {
  // The plans, as the providers name them (resources/engines.ts), and their CLIs
  claudeTitle: "Claude plan",
  claudePlan: "Claude plan",
  claudeCli: "Claude Code",
  claudeAbout: "Your agents run on your Claude plan, through Claude Code on your computer.",
  codexTitle: "ChatGPT plan, through Codex",
  codexPlan: "ChatGPT plan",
  codexCli: "Codex",
  codexAbout: "Your agents run on your ChatGPT plan, through Codex on your computer.",
  antigravityTitle: "Google AI plan, through Antigravity",
  antigravityPlan: "Google AI plan",
  antigravityCli: "Antigravity",
  antigravityAbout: "Your agents run on your Google AI plan, through Antigravity on your computer.",

  // The section on Connected accounts
  plansTitle: "Plans on your computers",
  plansAbout: "Your agents can run on a plan you already pay for, instead of an API key. " +
    "Sign in once, through its app on a computer of yours, and it works in every " +
    "conversation and space here.",
  plansPrivate:
    "Nothing is charged here for those calls. The sign-in stays on your computer: this app never sees it.",
  checking: "Checking your computers…",
  checkAgain: "Check again",
  checkFailed: "Couldn't check your computers: {why}",
  noComputerTitle: "Connect a computer of yours first",
  noComputerText:
    "Plans run through their apps on a computer of yours, a Mac, a Linux or Windows PC, while " +
    "it's on. Connect one, then sign in here.",
  connectComputer: "Connect a computer",
  personal: "your Personal space",

  // A plan's card
  signedIn: "Signed in",
  signIn: "Sign in",
  signInAgain: "Sign in again",
  signInOther: "Sign in on another computer",
  moreOn: "More for {computer}",
  rowSignedInAs: "Signed in as {account}",
  rowSignedIn: "Signed in",
  rowInstalled: "Installed, not signed in",
  rowMissing: "{cli} isn't installed",
  rowUnchecked: "Not checked yet",
  rowOld: "Didn't say: its computer program may need an update",
  rowSharedSomewhere:
    "Your plan runs on your own computer. This shared one runs your agents' tools.",
  sharedNotice:
    "{computer} is shared with others' agents in {spaces}, so your plans can't run on it.",
  sharedNoticeSomewhere: "{computer} is shared with others' agents, so your plans can't run on it.",
  offline: "Offline",
  checkedAt: "last checked {time}",
  version: "version {version}",
  howToInstall: "How to install",
  hideInstall: "Hide",
  howToFix: "How to use it",
  runsWhileOn: "Your agents use it while {computer} is on; until then, they use the app's models.",

  // Installing a CLI
  installIn: "In a terminal on {computer}, run:",
  installMissing: "{cli} isn't installed on {computer} yet. In a terminal there, run:",
  installAnywhere: "In a terminal on that computer, run:",
  installCommand: "The command that installs {cli}",
  installThen: "Then check again here. It's {cli}'s official install.",
  installAndSignIn: "Install {cli} and sign in",
  installRuns:
    "{cli} isn't installed on {computer} yet. Signing in runs {cli}'s official installer there first:",
  stepInstall: "Installing {cli} on {computer}",
  signOut: "Sign out",
  signOutFailed: "Couldn't sign out of {computer}: {why}",
  shareSignedIn: "{computer} is signed in to your {plan}. Sign out of it first: " +
    "a computer shared with others can't keep plan sign-ins.",
  shareOwnWarning: "Agents in {space} run on {computer} as you: they can read everything you " +
    "can on it, including your own sign-ins (Claude Code, Codex, SSH keys). Share it only with " +
    "people you trust.",
  installFailedTitle: "{cli} didn't install on {computer}",
  installFailedText:
    "Its installer stopped. What it said last is below, and how to install it yourself.",

  // A computer shared with others' agents
  sharedTitle: "{computer} is shared with others' agents",
  sharedWhy:
    "In {spaces}, each person's agents work on {computer} as you. Signed in there, your plan " +
    "would be theirs to use too, so it can't run on it.",
  sharedWhySomewhere:
    "Others' agents work on {computer} as you, where it's shared. Signed in there, your plan " +
    "would be theirs to use too, so it can't run on it.",
  sharedFix:
    "To use it for your plan, have their agents ask you first there: then nothing runs on it " +
    "without your yes. Or take it out of {spaces}, from its menu there.",
  askMeFirst: "Ask me first in {spaces}",
  openSpace: "Open {space}",
  keepAsIs: "Keep it as it is",
  listPair: "{first} and {second}",
  listMore: "{rest} and {last}",

  // Signing in, in a dialog
  signInTitle: "Sign in to your {plan}",
  signInThrough: "Through {cli}, on a computer of yours.",
  signInOn: "Through {cli}, on {computer}.",
  whichComputer: "On which computer?",
  whichHint: "Your agents' calls run there, so it needs to be on while they work.",
  ownSignIn:
    "It's your agents' own sign-in: your own use of {cli} on that computer stays as it is.",
  optionReady: "Ready to sign in",
  optionAsleep: "Asleep: it wakes up first",
  start: "Start signing in",
  offlineNote: "{computer} is offline. Turn it on, or start its computer program, then try again.",
  wakeNote: "{computer} wakes up first: it takes a moment.",
  stepStart: "Starting {cli} on {computer}",
  stepWake: "Waking {computer}",
  stepSignIn: "Sign in to your {plan}",
  stepSignInHere: "Open the sign-in page, and sign in with the account that has your plan.",
  stepSignInThere:
    "A sign-in page opens in the browser on {computer}. Sign in there, with the account that has your plan.",
  stepSignInWait: "The sign-in page shows here as soon as {cli} gives it.",
  stepEnterCode:
    "Open the sign-in page, sign in with the account that has your plan, and enter this code there:",
  openSignIn: "Open the sign-in page",
  notOpened: "Not on that screen? Open it here",
  stepCode: "Paste the code it gives you",
  codeLabel: "The code from the sign-in page",
  copyCode: "Copy the code",
  codeHint: "If the page shows a code once you've signed in, paste it here.",
  codePlaceholder: "Paste the code",
  send: "Send",
  gotCode: "The page gave you a code?",
  codeSent: "Code sent: finishing…",
  waiting: "Waiting for the sign-in to finish…",
  output: "What {cli} says",
  doneTitle: "Your {plan} is signed in",
  doneAs: "Signed in as {account}",
  doneOn: "On {computer}, through {cli}",
  doneNext: "Your agents run on it from now on, in every conversation and space here.",
  failedTitle: "{cli} didn't sign in",
  failedEnded: "It stopped without signing in. Try again, or read what it said below.",
  failedStart: "Couldn't sign in: {why}",
  tryAgain: "Try again",
  anotherComputer: "Another computer",
  cancel: "Cancel",
  close: "Close",
  done: "Done",

  // The command palette
  paletteGroup: "General",
  palettePlans: "Plans on your computers",
  paletteSignIn: "Sign in to your {plan}",
  paletteSignedIn: "Signed in on {computer}",
  paletteSignedInMany: {
    one: "Signed in on {count} computer",
    other: "Signed in on {count} computers",
  },
  paletteKeywords: "plan, subscription, sign in, computer, Claude, ChatGPT, Codex, Gemini, Google",

  // A computer's Files tab: a folder at a time
  filesWhere: "Where in the folder",
  filesOn: "{folder}, on {computer}",
  filesIn: "In {folder}",
  filesFilter: "Filter",
  filesFilterLabel: "Filter this folder",
  filesRefresh: "Refresh",
  filesUpTo: "Up to {folder}",
  filesEmpty: "Nothing here yet",
  filesEmptyText: "What you and your agents make in this folder shows up here.",
  filesEmptyDrop:
    "Drop files here to upload them. What you and your agents make in this folder shows up here too.",
  filesNoMatch: "Nothing here matches “{filter}”.",
  filesDownload: "Download {name}",
  filesJustUploaded: "uploaded",
  filesViewOnly: "Only {owner} changes files on {computer} here. You can open and download them.",
  filesItsOwner: "its owner",
  newFile: "New file",
  newFileName: "The new file's name",
  newFilePlaceholder: "notes.md, or src/new.ts",
  newFileMake: "Make the file",

  // Uploading to the folder shown
  upload: "Upload",
  dropTitle: "Drop to upload",
  dropTo: "To {folder} on {computer}",
  uploads: "Uploads",
  uploading: { one: "Uploading {count} file", other: "Uploading {count} files" },
  uploadsDone: { one: "{count} file uploaded", other: "{count} files uploaded" },
  uploadsFailed: { one: "{count} didn't upload", other: "{count} didn't upload" },
  uploadsAsking: { one: "{count} waits for you", other: "{count} wait for you" },
  uploadsLeft: "{size} left",
  uploadsHide: "Hide uploads",
  uploadsCancelAll: "Cancel all",
  uploadCancel: "Cancel uploading {name}",
  uploadOpen: "Open {name}",
  uploadProgressLabel: "Uploading {name}",
  uploadQueued: "Waiting to upload",
  uploadProgress: "{done} of {total}",
  uploadWaking: "Waking {computer}…",
  uploadWaiting: "Waiting for {computer}…",
  uploadFinishing: "Saving on {computer}…",
  uploadDone: "Uploaded",
  uploadDoneAs: "Uploaded as {name}",
  uploadReplaced: "Uploaded in place of the one there",
  uploadAsking: "There's one by this name already",
  uploadCancelled: "Cancelled",
  uploadSkipped: "Skipped: the one there stays",
  uploadIn: "in {folder}",

  // A name that's taken
  replaceTitle: "Replace “{name}”?",
  replaceText: "{folder} already has a file named “{name}”. Replacing it puts yours in its place.",
  replaceThere: "The one there: {size}, changed {time}",
  replaceYours: "Yours: {size}, changed {time}",
  replaceFolderTitle: "There's a folder named “{name}”",
  replaceFolderText:
    "A file can't replace a folder. Upload yours beside it under another name, or skip it.",
  replaceKeepAs: "Keep both uploads yours as “{name}”.",
  replaceAll: {
    one: "Do the same for the other file that's already there",
    other: "Do the same for the other {count} files that are already there",
  },
  replace: "Replace",
  keepBoth: "Keep both",
  skip: "Skip",

  // Folders dropped
  folderDropped:
    "“{name}” is a folder, and folders can't be uploaded. Drop the files in it, or a zip of it.",
  foldersDropped: {
    one: "{count} folder wasn't uploaded: folders can't be. Drop the files in it, or a zip of it.",
    other:
      "{count} folders weren't uploaded: folders can't be. Drop the files in them, or a zip of each.",
  },

  // Why an upload didn't go
  uploadSignedOut: "You're signed out. Sign in again, then try again.",
  uploadForbidden: "You can't change files on this computer.",
  uploadNotFound: "This computer isn't in this space anymore.",
  uploadTooLarge: "It's {size}: a file can be {most} at most.",
  uploadTooLargeHere: "It's {size}: too large to send through this app.",
  uploadOutdated:
    "{computer}'s computer program is too old to take uploads. It updates itself, or its owner updates it: then try again.",
  uploadOffline: "{computer} is offline. Try again once it's on.",
  uploadNoWake: "{computer} didn't wake up in time. Try again.",
  uploadUnavailable: "{computer} couldn't wake up. Try again in a moment.",
  uploadFull: "There's no room left on {computer}'s disk.",
  uploadFolderThere: "There's a folder by that name, and a file can't replace it.",
  uploadInvalid: "That name can't be used here.",
  uploadRestart: "This upload was interrupted and has to start again.",
  uploadNoLength: "The browser didn't say how big it is. Try again.",
  uploadNetwork: "The connection dropped. Try again.",
  uploadFailed: "It didn't upload. Try again.",

  // An agent's call that moves a file between the chat and the computer
  stepSaved: "Saved {file} to {path}",
  stepSaves: "Saves {file} to {path}",
  stepSavesFile: "Saves a file from this chat to {path}",
  stepSavesFolder: "Saves a file from this chat in the space's folder",
  stepSent: "Sent {file}",
  stepSends: "Sends {path} to this chat",
});
