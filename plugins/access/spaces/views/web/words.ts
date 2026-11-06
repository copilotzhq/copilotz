/**
 * The words of spaces' web front end (the tree, a space's page, its members, settings and
 * invitations, the palette's steps), in English. An app gives its own under `spaces.<key>`.
 */
import { defineWords } from "../../../../../hosts/web/mod.ts";

export const say = defineWords("spaces", {
  // Space names and roles (who.ts)
  personal: "Personal",
  theirPersonal: "{name}'s Personal",
  roleViewer: "Viewer",
  roleViewerLets: "Reads what's here",
  roleEditor: "Editor",
  roleEditorLets: "Reads, chats and adds things here",
  roleManager: "Manager",
  roleManagerLets: "Also invites people, and renames the space",
  agentEditorLets: "Answers chats here, and adds notes, memories and files",
  agentViewerLets: "Reads what's here for chats elsewhere; doesn't answer here",
  aRole: "a {role}",
  anRole: "an {role}",
  listPair: "{first} and {second}",
  listMore: "{rest} and {last}",
  invitedOne: "Invited {emails}. They'll join once they accept.",
  invitedMany: "Invited {emails}. Each joins once they accept.",
  kindPeople: "People",

  // Steps in the command palette (steps.ts)
  newSpace: "New space",
  nameIt: "Name it",
  newSpaceNote: "A shared space, to work in with others: you'll manage it, and invite them.",
  createNamed: "Create “{name}”",
  atMost: "At most {count} characters",
  renameTitle: "Rename {name}",
  newName: "Its new name",
  renameNote: "Everyone in it sees the new name, in the sidebar and on its chats.",
  renameTo: "Rename to “{name}”",
  archiveTitle: "Archive {name}?",
  archiveNote:
    "It stays readable, as it is, and it's listed apart, under Archived. Restore it any time.",
  archiveNamed: "Archive {name}",
  keepIt: "Keep it as it is",
  leaveTitle: "Leave {name}?",
  leaveNote:
    "You'll no longer see its chats, memories or computers; what you added stays there. To come back, someone who manages it invites you again.",
  leaveNamed: "Leave {name}",
  stay: "Stay",

  // The space page's header (header.tsx)
  peopleCount: { one: "{count} person", other: "{count} people" },
  agentsCount: { one: "{count} agent", other: "{count} agents" },
  workBoth: "{people} and {agents} work here.",
  workPeopleOnly: {
    one: "{count} person works here; no agent does yet.",
    other: "{count} people work here; no agent does yet.",
  },
  rename: "Rename",
  restore: "Restore",
  archiveMenu: "Archive…",
  leaveMenu: "Leave…",
  settings: "Settings",
  spaceNameLabel: "The space's name",
  renameSpace: "Rename the space",
  justYou: "Just you",
  archived: "Archived",
  shared: "Shared",
  personalAbout: "Yours alone, with your agents. To work with others, make a shared space.",
  membersNamed: "Members: {names}",
  invite: "Invite",
  inviteSomeone: "Invite someone",
  newChat: "New chat",
  newChatHere: "New chat here",
  moreOf: "{name}: more",

  // A space's agents (agents.tsx)
  agents: "Agents",
  addAgent: "Add an agent",
  agentsAboutPersonal: "They work here for you. One answers new chats; @name asks another.",
  agentsAboutShared:
    "They work for whoever asks them, and reach only what that person can. One answers new chats; @name asks another.",
  noAgents: "No agent works here yet: chats here have no one to answer them.",
  madeIn: "Made in {space}",
  madeElsewhere: "Made in another space",
  appAgent: "One of the app's agents",
  anAgent: "An agent",
  makeAnswer: "Make it answer new chats",
  edit: "Edit {name}",
  view: "View {name}",
  removeFromSpace: "Remove from this space",
  answersNew: "Answers new chats",
  roleOf: "{name}'s role",

  // An invitation to the person (invitation.tsx, invitations.tsx)
  join: "Join",
  joinNamed: "Join {name}",
  decline: "Decline",
  invitationTo: "Invitation to {name}",
  invitedTo: "Invited to {space}",
  invitedYou: "{by} invited you to {space}, as {role}.",
  byAs: "By {by} · as {role}",
  invitedAt: "Invited {time}. Joining shows you its chats, memories and computers.",
  invitations: "Invitations",
  moreInvitations: { one: "{count} more invitation", other: "{count} more invitations" },

  // Inviting to a space (invite-dialog.tsx)
  inviteTitle: "Invite someone to {name}",
  inviteAbout:
    "They'll see what's in it (its chats, memories and computers) and work with its agents.",
  addAgentTitle: "Add an agent to {name}",
  addAgentAbout: "Agents work for whoever asks them, and reach only what that person can.",
  done: "Done",

  // The invite form and its dialog's tabs (invite.tsx, inviting.tsx)
  theirEmail: "Their email",
  emailPlaceholder: "name@example.com",
  theirRole: "Their role",
  inviteHint: "{lets}. Several? Separate them with commas.",
  inviteHintMany: "{lets}. {count} addresses.",
  personalAlone:
    "Personal is yours alone. To work with others, make a shared space and invite them there.",
  managersAdd: "Those who manage {name} add people to it.",
  managersAddThis: "Those who manage this space add people to it.",
  whoToAdd: "Who to add",

  // The Members tab (members.tsx)
  membersPersonal:
    "Personal is yours alone: you, and the agents that work for you. To work with others, make a shared space (New space, in the sidebar) and invite them there.",
  waitingToJoin: "Waiting to join",
  invitePeople: "Invite people",
  people: "People",
  spacesDrawing: "Spaces drawing on it",
  spaceMembersIn: "A space whose members are in this one",
  person: "Person",
  you: "You",
  leaveThisSpace: "Leave this space",
  takeOut: "Take {name} out",
  askedBy: "{by} asked for them to join.",
  askedByWhy: "{by} asked for them: “{reason}”",
  asked: "They asked to join.",
  askedWhy: "They asked: “{reason}”",
  letIn: "Let in",
  turnDown: "Turn down",

  // Making a space in the sidebar (new-space.tsx)
  nameNewSpace: "Name the new space",
  nameSpace: "Name the space",
  makeSpace: "Make the space",
  cancel: "Cancel",

  // A message that named agents who don't answer in the space (not-here.tsx)
  ok: "OK",
  nothingSent: "Nothing was sent: it named someone who doesn't answer here.",
  onlyReadsTitle: { one: "{who} only reads {where}", other: "{who} only read {where}" },
  notWorkingTitle: { one: "{who} doesn't work in {where}", other: "{who} don't work in {where}" },
  notNow: "Not now",
  makeEditorsSend: { one: "Make {who} an editor and send", other: "Make them editors and send" },
  addSend: { one: "Add {who} and send", other: "Add them and send" },
  waitingReads: {
    one: "Your message is waiting: as an editor, it answers here too, and it goes as it is.",
    other: "Your message is waiting: as editors, they answer here too, and it goes as it is.",
  },
  waitingAdd: {
    one: "Your message is waiting: add it to {where}, as an editor, and it goes as it is.",
    other: "Your message is waiting: add them to {where}, as editors, and it goes as it is.",
  },
  askManagersEditor: {
    one:
      "Your message wasn't sent. Ask someone who manages {where} to make it an editor, or send it without the @.",
    other:
      "Your message wasn't sent. Ask someone who manages {where} to make them editors, or send it without the @.",
  },
  askManagersAdd: {
    one:
      "Your message wasn't sent. Ask someone who manages {where} to add it, or send it without the @.",
    other:
      "Your message wasn't sent. Ask someone who manages {where} to add them, or send it without the @.",
  },

  // The org's About section (org-about.tsx)
  aboutLabel: "About",
  name: "Name",
  orgNamePersonal: "Your personal org shows as Personal, to you.",
  orgNameOwner: "What everyone in it sees it as: in the switcher, and when they're invited.",
  orgNameOthers: "Its owners change its name.",
  orgNameLabel: "The org's name",
  yourRole: "Your role",
  staffRole:
    "Platform staff: you reach all of it, and what you do here is on its record, as yours.",
  staff: "Staff",
  details: "Details",
  kind: "Kind",
  kindPersonal: "Personal: yours alone",
  kindTeam: "Team",
  roles: "Roles",
  orgRoleLine: "{role} {lets}.",
  id: "Id",
  copyOrgId: "Copy the org's id",
  seesYou: "What you can see",
  seesOwners: "What owners and admins can see",
  seesAsOwner:
    "As an owner, you reach everything in {org}: every space, Personal ones included, with their conversations, agents, computers and memories. It's there so you can help, and hand work over when someone leaves. People's Personal spaces are still theirs.",
  seesAsAdmin:
    "As an admin, you reach everything in {org}: every space, Personal ones included, with their conversations, agents, computers and memories. It's there so you can help, and hand work over when someone leaves. People's Personal spaces are still theirs.",
  seesTheirs:
    "{org}'s owners and admins reach everything in it: every space, Personal ones included, with their conversations, agents, computers and memories. It's there so they can help, and hand work over when someone leaves. Platform staff can come in too; what they do is on {org}'s record.",
  save: "Save",
  orgSaved: "Saved. Everyone in it sees the new name.",

  // The org's People section (org-members.tsx)
  orgPersonalAlone:
    "A personal org is yours alone. To work with others, make a team org (New organization, in the switcher) and invite them there.",
  invitedHeading: "Invited",
  removedHanded: {
    one: "{who} is out of {org}. A space only they managed went on: {spaces}.",
    other: "{who} is out of {org}. {count} spaces only they managed went on: {spaces}.",
  },
  removedPlain: "{who} is out of {org}.",
  onlyOwner: "The org's only owner: make someone else an owner first",
  removeFromOrg: "Remove from the org…",
  orgInvited: {
    one: "Invited {emails} to {org}. They'll join once they accept, signed in with that email.",
    other: "Invited {emails} to {org}. Each joins once they accept, signed in with that email.",
  },
  invitedTime: "Invited {time}",
  takeBackTo: "Take back the invitation to {email}",
  takeBack: "Take back",
  removeTitle: "Remove {name} from {org}?",
  removeNamed: "Remove {name}",
  removeMeansOut:
    "They're signed out of {org} at once, wherever they are, and leave every space in it.",
  removeMeansPersonal:
    "Their Personal space stays, as it is: the org's owners and admins still reach it.",
  heirLabel: "Shared spaces only they manage go to",
  heirHint: "They become its manager there. Spaces others manage too stay as they are.",
  youNamed: "You ({name})",

  // The palette (palette.tsx, pick.tsx)
  invitedYouAs: "{by} invited you, as {role}",
  declineInvitation: "Decline the invitation to {name}",
  inviteToNamed: "Invite someone to {name}…",
  renameNamed: "Rename {name}…",
  restoreNamed: "Restore {name}",
  archiveNamedMore: "Archive {name}…",
  leaveNamedMore: "Leave {name}…",
  tabIn: "{name} · {tab}",
  thisSpace: "This space",
  spacesGroup: "Spaces",
  youreHere: "You're here",
  createGroup: "Create",
  newSpaceMore: "New space…",
  newSpaceNamed: "New space “{name}”",
  // Words the palette finds an item by, apart by spaces
  keysAcceptInvitation: "invitation accept",
  keysInvitation: "invitation",
  keysInvite: "people member email add",
  keysRestore: "unarchive archived",
  keysPersonal: "personal mine",
  keysNewSpace: "create make shared",
  keysPick: "personal",
  keysCreate: "create make",

  // The side panel beside a chat (panel.tsx)
  panelMissing: "This chat's space isn't one of yours.",
  panelLabel: "{name}, beside this chat",
  sharedSpace: "Shared space",
  openPage: "Open {name}'s page",
  tabsOf: "{name}'s tabs",

  // Invitations not yet accepted (pending.tsx)
  invitedNotJoined: "Invited, not joined yet",
  invitedByYou: "Invited by you {time}",
  invitedBy: "Invited by {by} {time}",

  // A space's page (space.tsx, sections.tsx)
  partsOf: "{title}: its parts",
  notYourSpace: "Not your space",
  notInSpace: "You're not in this space",
  goHome: "Go home",
  notInSpaceAbout:
    "It's for its members. Someone who manages it can invite you; your spaces are in the sidebar.",
  nothingHere: "Nothing here yet",
  nothingHereAbout: "This app adds nothing to a space's page.",
  isArchived: "{name} is archived",
  archivedNote: "It stays readable, as it was, and it's listed apart, under Archived.",

  // What the space adds to the app's sidebar, tabs and panel (web.tsx)
  general: "General",
  members: "Members",
  space: "Space",

  // A space's settings (settings.tsx)
  managersChange: "Those who manage {name} change its settings.",
  nameSettingPersonal: "Your Personal space is always called Personal.",
  nameSettingShared: "What everyone sees this space as: in the sidebar, and on its chats.",
  copySpaceId: "Copy the space's id",
  leave: "Leave",
  leaveAbout: "You'll no longer see its chats, memories or computers; what you added stays here.",
  archiveSetting: "Archive",
  archivedAt:
    "Archived {time}. It's listed apart, and readable as it was; restored, it's listed with the others again.",
  archiveAbout:
    "When the work here is done: everything stays as it was, and readable, and the space is listed apart, under Archived. Restore it any time.",
  archiveReadableLead: "It stays readable.",
  archiveReadableRest: "Its chats, memories and computers stay as they are, for everyone in it.",
  archiveApartLead: "It's listed apart,",
  archiveApartRest:
    "under Archived in the sidebar, and agents in other spaces' chats stop looking in it.",
  archiveBackLead: "It comes back as it was:",
  archiveBackRest: "anyone who manages it can restore it, any time.",
  saved: "Saved.",
  answersAbout: "Who answers a chat started here. Anyone can still ask another agent with @name.",
  answersViewersOnly:
    "Its agents only read here (viewers): make one an editor, in Members, to answer chats.",
  answersNone: "No agent works here: chats here have no one to answer them.",
  answersLabel: "The agent that answers new chats",
  answersNow: "{name} answers new chats here now.",

  // The sidebar tree (tree.tsx)
  acrossOrg: "Across the org",
  acrossOrgHint: "The org's other spaces: you reach them by running it, not as a member",
  spacesUnder: "{title}: spaces",
  nameArchived: "{name} (archived)",
  personalHint: "Personal: just you and your agents",
  showWhat: "Show {name}'s {what}",
  hideWhat: "Hide {name}'s {what}",
  showIn: "Show what's in {name}",
  hideIn: "Hide what's in {name}",
});
