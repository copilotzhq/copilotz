/**
 * The directory plugin's contract: what other plugins' front ends (the
 * shell's switcher, the org page, staff's console) use of it in the
 * browser, its web part (web.ts): the person's orgs and invitations, going
 * between them, and staff's console. They reach the rest over HTTP, at the
 * directory's routes (`/orgs`, `/console/orgs`, `/console/codes`).
 */
export {
  answerOrgInvite,
  arrived,
  asStaff,
  type ConsoleOrg,
  consoleOrgs,
  createGiftCode,
  createOrg,
  currentOrg,
  deleteOrg,
  enterOrg,
  exportOrgUrl,
  type GiftCode,
  giftCodes,
  loadOrgs,
  moveOrg,
  type Org,
  type OrgInvite,
  orgName,
  type Orgs,
  type OrgsState,
  reenter,
  refreshOrgs,
  revokeGiftCode,
  type Switching,
  updateOrg,
  useOrgs,
  useSwitching,
} from "./web.ts";
