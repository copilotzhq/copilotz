/**
 * The words of the web shell (sidebar, frame, side panel, account menu, org roles), in English.
 * An app gives its own under `shell.<key>`.
 */
import { defineWords } from "../../../../hosts/web/words.ts";

export const say = defineWords("shell", {
  // The frame (frame.tsx)
  general: "General",
  goHome: "Go home",
  signOut: "Sign out",
  keysPanel: "side panel toggle",
  homeOf: "{brand}: home",
  closeSidebar: "Close sidebar",
  openSidebar: "Open sidebar",
  sidebar: "Sidebar",
  search: "Search",
  searchTitle: "Search spaces and chats, or run a command ({shortcut})",
  spacesAndChats: "Spaces and chats",
  skipToContent: "Skip to content",

  // The side panel (panel.tsx, shared/panel.ts)
  panelWidth: "Panel width",
  panel: "Panel",
  close: "Close",
  showPanel: "Show the panel",
  hidePanel: "Hide the panel",
  showPanelTitled: "Show the {title} panel",
  hidePanelTitled: "Hide the {title} panel",

  // The account menu (me.tsx), and naming yourself there
  signedIn: "Signed in",
  yourAccount: "Your account",
  yourName: "Your name",
  addYourName: "Add your name",
  nameAbout: "How people and agents here see you.",
  nameLabel: "Name",
  nameEmpty: "Leave it empty to go by your email.",
  nameNotSaved: "Your name wasn't saved. {reason}",
  nameTryAgain: "Your name wasn't saved. Try again in a moment.",
  cancel: "Cancel",
  save: "Save",

  // An address with nothing to show (shell.tsx, default.tsx)
  nothingHere: "Nothing here",
  nothingOpens: "This address doesn't open anything.",
  nothingToShow: "Nothing to show",
  nothingToShowAbout: "There's no page for this here, or it isn't shared with you.",

  // Org roles (shared/orgs.ts)
  roleOwner: "Owner",
  roleOwnerLets: "Runs the org: everything admins do, and makes or unmakes owners",
  roleAdmin: "Admin",
  roleAdminLets: "Invites people, changes roles, and reaches everything in the org",
  roleMember: "Member",
  roleMemberLets: "Works in their spaces, makes new ones, and sees who's in the org",
  roleGuest: "Guest",
  roleGuestLets: "Reaches only the spaces they're invited to",
});
