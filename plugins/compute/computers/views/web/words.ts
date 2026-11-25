/**
 * The words of computers' web front end, in English: so far, a person's
 * plans (Your plans and Your computers on Your AI, the connect flow, the
 * welcome's step, and the palette's), a computer's Files tab (its folders, uploading to
 * them, why an upload didn't go), and an agent's calls that move a file
 * between a chat and a computer. An app gives its own under
 * `computers.<key>`. With tiers, a plan's name is what they list (in the
 * app's words: `text.<English>`); without, the providers'
 * (resources/engines.ts): "Claude plan", "ChatGPT plan, through Codex",
 * "Google AI plan, through Antigravity".
 */
import { defineWords } from "../../../../../hosts/web/words.ts";

export const say = defineWords("computers", {
  // The plans' CLIs, and the plans as the app's own computers name them (without tiers to list them)
  claudeCli: "Claude Code",
  codexCli: "Codex",
  antigravityCli: "Antigravity",
  claudeTitle: "Claude plan",
  codexTitle: "ChatGPT plan, through Codex",
  antigravityTitle: "Google AI plan, through Antigravity",
  grokCli: "Grok Build",
  grokTitle: "Grok plan",

  // Your plans, on Your AI
  plansTitle: "Your plans",
  plansAbout: "Your agents run on AI plans you already pay for, instead of the app's models. " +
    "Connect each one once, and it works in every conversation and space here.",
  connectPlans: "Connect your plans",
  plansPaid: "Your plan pays for the AI.",
  plansCloud: "A cloud computer you use for it is charged while it's awake.",
  plansPrivate: "Sign-ins stay on your computers, or sealed on the server: nobody else sees them.",
  checkFailed: "Couldn't check your computers: {why}",
  connect: "Connect",
  fix: "Fix",
  signOut: "Sign out",
  signOutOn: "Sign out on {computer}",
  signOutServer: "Disconnect {plan}",
  signOutFailed: "Couldn't sign out of {computer}: {why}",
  alsoThrough: "Also through {cli}, on a computer",
  moreFor: "More for {plan}",
  cardReadyServer: "Connected as {account}, on the server: always ready.",
  cardReady: "Running on {computer} ({state}).",
  cardReadyBackup: "Running on {computer} ({state}), with {backup} ready as backup.",
  cardOnline: "online",
  cardAsleep: "asleep: it wakes when your agents need it",
  cardAlso: "Also through {cli} on {computer}, as backup.",
  cardAway: {
    one: "Signed in on {computers}, which is off. Your agents use the app's models until it's on.",
    other:
      "Signed in on {computers}, which are off. Your agents use the app's models until one is on.",
  },
  cardReconnect: "{plan} needs you to sign in again.",
  cardShared:
    "Signed in only on {computers}, shared with others' agents, so your plan can't run there.",
  cardOff: "Not connected: your agents use the app's models.",
  cardLimited:
    "At its limit since {time}: your agents use your next plan, or the app's models, until it resets.",
  sharedNotice:
    "{computer} is shared with others' agents in {spaces}, so your plans can't run on it.",
  sharedNoticeSomewhere: "{computer} is shared with others' agents, so your plans can't run on it.",
  howToFix: "How to fix",
  personal: "your Personal space",

  // The person's order of their plans
  orderTitle: "Use my plans in this order",
  orderAbout:
    "When a model runs on more than one of your plans, your agents try them in this order.",
  moveUp: "Move up",
  moveDown: "Move down",
  notConnected: "not connected",
  orderFailed: "Couldn't save the order: {why}",

  // Your computers
  yoursTitle: "Your computers",
  yoursAbout: "Where your plans run, and your agents' work.",
  yoursServes: "Runs {plans}",
  yoursServesNone: "No plans signed in here",
  yoursNone:
    "No computer yet. A plan that runs through its app needs one: connecting it sets one up for you.",
  terminal: "Terminal",
  signInHere: "Sign in to your plans here",
  addComputer: "Add a computer",
  online: "Online",
  offline: "Offline",
  seenAt: "last seen {time}",

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
  shareSignedIn: "{computer} is signed in to your {plan}. Sign out of it first: " +
    "a computer shared with others can't keep plan sign-ins.",
  shareOwnWarning: "Agents in {space} run on {computer} as you: they can read everything you " +
    "can on it, including your own sign-ins (Claude Code, Codex, SSH keys). Share it only with " +
    "people you trust.",

  // The connect flow: which plans
  flowTitle: "Connect your plans",
  flowPick: "Pick each plan you pay for: your agents run on them instead of the app's models.",
  flowConnected: "Connected",
  flowNext: "Next",
  // Where they run
  flowWhere: "Where should they run?",
  flowWhereAbout: "{plans} run through an app on a computer. We set it up, and keep it up to date.",
  whereCloud: "In the cloud",
  whereCloudAbout:
    "Always ready. It sleeps when your agents aren't working, and you pay only while it's awake.",
  recommended: "Recommended",
  whereLocal: "On this computer",
  whereLocalAbout: "Free. Works while this computer is on. Needs one line in your terminal, once.",
  whereNone: "Open this page on your computer to connect it.",
  making: "Making your cloud computer…",
  makeFailed: "Couldn't make your cloud computer: {why}",
  back: "Back",
  // The checklist
  lineComputer: "{computer} is ready",
  lineWaking: "Waking {computer}… (about 30 seconds)",
  lineGetting: "Getting {computer} ready…",
  lineOld: "{computer} runs an older program than this app: going on as it is.",
  lineInstall: "{cli} is installed",
  lineInstalling: "Installing {cli} on {computer}…",
  lineSignIn: "Sign in to {plan}",
  lineSignedInAs: "Signed in as {account}",
  lineAlready: "Signed in already",
  lineTest: "{plan} answers on your plan",
  lineTesting: "Asking it a short question…",
  lineAnswered: "It answered: “{text}”",
  lineLimit:
    "Connected. Your {plan} is at its limit right now: your agents use it again when it resets.",
  lineModel: "Connected. {model} isn't in your plan, so your agents use the next one for it.",
  failOff: "{computer} is off. Turn it on, or use a cloud computer instead.",
  failShared: "{computer} is shared with others' agents, so plans can't run on it.",
  failReach: "Couldn't reach {computer}: {why}",
  failInstall: "{cli} didn't install on {computer}. What its installer said is below.",
  failWindows: "Install {cli} on {computer} from its terminal, once:",
  orInstall: "Or install it from {computer}'s terminal, then check again:",
  installCommand: "The command that installs {cli}",
  openTerminal: "Open {computer}'s terminal",
  failSignIn: "Signing in to {plan} didn't finish.",
  failGone: "{computer} went offline.",
  failSignedOut: "{plan} says you're not signed in.",
  failTest: "{plan} didn't answer: {why}",
  failOldLaptop:
    "{computer} runs an older Copilotz program and didn't update itself. Quit Copilotz there and open it again.",
  failOldCloud:
    "{computer} runs an older program than this app. Cloud computers are updating: try again in a few minutes.",
  useCloud: "Use a cloud computer",
  signInAgain: "Sign in again",
  tryAgain: "Try again",
  checkAgain: "Check again",
  flowDone: "Your agents now run on {plans}.",
  flowLeft: "What's left is below, with what to do.",
  flowNone: "Nothing's connected yet. What's left is below, with what to do.",
  // A CLI's sign-in, on a line
  stepSignInHere: "Open the sign-in page, and sign in with the account that has your plan.",
  stepSignInThere:
    "A sign-in page opens in the browser on {computer}. Sign in there, with the account that has your plan.",
  stepSignInWait: "The sign-in page shows here as soon as {cli} gives it.",
  stepEnterCode:
    "Open the sign-in page, sign in with the account that has your plan, and enter this code there:",
  openSignIn: "Open the sign-in page",
  notOpened: "Not on that screen? Open it here",
  codeLabel: "The code from the sign-in page",
  copyCode: "Copy the code",
  codeHint: "If the page shows a code once you've signed in, paste it here.",
  codePlaceholder: "Paste the code",
  send: "Send",
  gotCode: "The page gave you a code?",
  codeSent: "Code sent: finishing…",
  output: "What {cli} says",
  cancel: "Cancel",
  close: "Close",
  done: "Done",

  // The welcome's step
  welcomeNone: "None of these",
  welcomeNoneThen: "Your agents use the app's models.",
  welcomeConnect: "Connect them",
  welcomeLater: "You can connect them later, in Your AI.",

  // The command palette
  paletteGroup: "General",
  paletteConnect: "Connect your {plan}",
  paletteConnected: "Connected",
  paletteKeywords:
    "plan, subscription, sign in, computer, Claude, ChatGPT, Codex, Gemini, Google, Grok",

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

  // What a computer the app keeps costs (the `computer.cost` View)
  costHour: {
    one: "About {price} per hour of work, and it sleeps {count} minute after.",
    other: "About {price} per hour of work, and it sleeps {count} minutes after.",
  },
  costCoversOnce: {
    one: "Your {amount} covers about {count} hour of work, after this month's disk.",
    other: "Your {amount} covers about {count} hours of work, after this month's disk.",
  },
  costCoversMonth: {
    one: "Your {amount} a month covers about {count} hour of work, after the disk.",
    other: "Your {amount} a month covers about {count} hours of work, after the disk.",
  },
  costMonth: "This month: {awake} awake · {price} · disk {disk}",
  costMonthNoDisk: "This month: {awake} awake · {price}",
  awakeHours: "{hours}h {minutes}m",
  awakeMinutes: "{minutes}m",
});
