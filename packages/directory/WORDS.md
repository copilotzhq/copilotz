# @copilotz/directory's words

Every word the directory's web front end shows (the org switcher, the org's page, staff's
console), by key, with its English. An app changes any of them with a `words` resource (see
Copilotz's README, "Words"). They keep the keys they had in the web shell (`shell.<key>`), beside
the shell's own (Copilotz's hosts/web/WORDS.md). `{name}` is a blank; a phrase in braces
`{one, other}` has plural forms, chosen by the `{count}` blank.

Generated: `deno run -A packages/directory/tests/words.ts`.


## directory

| Key | English |
|---|---|
| `directory.personalOrg` | Personal |

## shell

| Key | English |
|---|---|
| `shell.aboutOrg` | About this organization |
| `shell.actions` | Actions |
| `shell.active` | Active |
| `shell.allOrgsConsole` | All orgs (console) |
| `shell.atMost` | At most {count} characters |
| `shell.cancel` | Cancel |
| `shell.cantUndo` | This can't be undone |
| `shell.chooseOrg` | Choose one from the switcher at the top of the sidebar. |
| `shell.claimBy` | Claim by |
| `shell.claimedBy` | by {org}, {day} |
| `shell.claimHint` | Empty: any time. |
| `shell.codeClaimed` | Claimed |
| `shell.codeExpired` | Expired |
| `shell.codeMade` | · made {time} |
| `shell.codeRevoked` | Taken back |
| `shell.codesCount` | one: {count} code, the newest first / other: {count} codes, the newest first |
| `shell.codeShortTitle` | Only the start of what's kept: it can't be claimed with this |
| `shell.codeWaiting` | Waiting |
| `shell.consoleAbout` | Every org on this app: what each last reported, where its rows live, and what you can do about it. Nothing here reads an org's content. |
| `shell.consoleShows` | What the console shows |
| `shell.consoleTitle` | Console |
| `shell.continueAs` | Continue as {role} |
| `shell.copyCode` | Copy the code |
| `shell.copyOrgId` | Copy the org's id |
| `shell.createNamed` | Create “{name}” |
| `shell.createOrg` | Create organization |
| `shell.credits` | Credits |
| `shell.decline` | Decline |
| `shell.declineOrgInvite` | Decline {name}'s invitation |
| `shell.deleteAbout` | Everything in it goes: its people's memberships, spaces, conversations, agents, files and usage. Its people are signed out of it at once. Export its rows first if you may need them. |
| `shell.deleteForGood` | Delete for good |
| `shell.deleteMore` | Delete for good… |
| `shell.deleteTitle` | Delete {name} for good? |
| `shell.enterAsStaff` | Enter as staff |
| `shell.enteringAsStaff` | Entering as staff |
| `shell.exportFirst` | Export its rows (SQL) first |
| `shell.exportRows` | Export its rows (SQL) |
| `shell.filterAll` | All |
| `shell.filterTeams` | Teams |
| `shell.footAll` | one: {count} organization · the most recently active first / other: {count} organizations · the most recently active first |
| `shell.footSome` | {shown} of {total} organizations · the most recently active first |
| `shell.forStaff` | For platform staff |
| `shell.forStaffAbout` | The console lists every organization, for the people who run this app. |
| `shell.giftCodes` | Gift codes |
| `shell.giftCodesAbout` | Credits waiting to be claimed. Someone who runs an org types one in under Billing, and its credits are that org's. |
| `shell.goHome` | Go home |
| `shell.goingInto` | Going into {name} |
| `shell.goIntoAsStaff` | Go into {name} as staff: what you do there is on its record |
| `shell.heldBack` | {section} is for this org's owners and admins. Ask one of them if you need something changed there. |
| `shell.hereAsStaff` | You're here as staff |
| `shell.inAsStaff` | You're in {name} as staff. What you do here is on its record. |
| `shell.inAsStaffTitle` | You're in {name} as platform staff: what you do is on its record |
| `shell.inItAsStaff` | You're in it as staff |
| `shell.invitations` | Invitations |
| `shell.invitationsCount` | {count} invitations |
| `shell.invitedAs` | You're invited, as {role} |
| `shell.invitedAsAt` | You're invited, as {role} · {time} |
| `shell.invitedFromAs` | {from} invited you, as {role} |
| `shell.invitedFromAsAt` | {from} invited you, as {role} · {time} |
| `shell.isDeleted` | {name} is deleted. |
| `shell.isSuspended` | {name} is suspended. |
| `shell.join` | Join |
| `shell.joinNamed` | Join {name} |
| `shell.justYou` | Just you |
| `shell.keptIt` | Done, I've kept it |
| `shell.keysAcceptOrgInvite` | invitation accept organization |
| `shell.keysConsole` | staff console platform suspend |
| `shell.keysNewOrg` | create team organization org |
| `shell.keysOrgInvite` | invitation organization |
| `shell.keysOrgSettings` | members usage invite roles organization |
| `shell.keysSwitch` | organization org switch |
| `shell.lapseHint` | Empty: they don't lapse. |
| `shell.lapseOn` | Credits lapse on |
| `shell.lastActive` | Last active |
| `shell.lift` | Lift the suspension |
| `shell.liftAbout` | Its people can go in again, as before. Nothing in it changed while it was suspended. |
| `shell.liftMore` | Lift the suspension… |
| `shell.liftTitle` | Lift the suspension of {name}? |
| `shell.makeCode` | Make a {amount} code |
| `shell.makeTheCode` | Make the code |
| `shell.moreOf` | {name}: more |
| `shell.moveAbout` | For big orgs: gives it a schema of its own, so its load and its rows stand apart from the shared pool. |
| `shell.movedOrg` | You're no longer in the org you were in. You're in {name}. |
| `shell.moveMore` | Move to another schema… |
| `shell.moveRows` | Move its rows |
| `shell.moveText` | It's closed for a moment, its rows are copied to the new schema as they are, and it opens there on its next use. Its people may see it reconnect. |
| `shell.moveTitle` | Move {name} |
| `shell.name` | Name |
| `shell.nameIt` | Name it |
| `shell.newGiftCode` | New gift code |
| `shell.newOrg` | New organization |
| `shell.newOrgAbout` | For a team: you'll own it, and invite people by email. |
| `shell.newOrgMore` | New organization… |
| `shell.newOrgNameHint` | Usually your team's or company's name. You can change it later. |
| `shell.newOrgPlaceholder` | e.g. Acme |
| `shell.newSchema` | New schema |
| `shell.noCodes` | No gift codes yet |
| `shell.noCodesAbout` | A gift code gives whoever claims it credits for their org. |
| `shell.noMatch` | No organization matches |
| `shell.notePlaceholder` | Conference, November |
| `shell.nothingMatches` | Nothing matches “{search}” |
| `shell.nothingToSet` | Nothing to set here |
| `shell.nothingToSetAbout` | This app adds no sections to an organization's page. |
| `shell.nothingYet` | Nothing in this list yet. |
| `shell.notInOrg` | You're not in an organization |
| `shell.notShownAgain` | This won't be shown again |
| `shell.notShownAgainAbout` | Only a fingerprint of it is kept, so nobody can look it up later. Copy it now. If it's lost, take this one back and make another. |
| `shell.notYet` | Not yet |
| `shell.nowIn` | Now in |
| `shell.nowLivesIn` | {name} now lives in “{schema}”. |
| `shell.oneOrg` | One organization here |
| `shell.oneOrgAbout` | This app serves a single organization, so there's nothing to set here. |
| `shell.openAgain` | {name} is open again. |
| `shell.orgAboutGuest` | What {name} is. As a guest, you work in the spaces you're invited to. |
| `shell.orgAboutMember` | What {name} is, and who's in it. |
| `shell.orgAboutPersonal` | Your own organization: just you, and what you make alone. |
| `shell.orgAboutRuns` | Who's in {name}, what it uses, and what it's called. |
| `shell.orgAboutStaff` | You're here as platform staff: what you do is on {name}'s record. |
| `shell.organization` | Organization |
| `shell.organizations` | Organizations |
| `shell.orgSection` | {name}: {section} |
| `shell.orgSettings` | Organization settings |
| `shell.orgSettingsOf` | {name}'s settings |
| `shell.people` | People |
| `shell.personal` | Personal |
| `shell.personalOrg` | Personal org |
| `shell.placement` | Placement |
| `shell.refresh` | Refresh |
| `shell.rename` | Rename |
| `shell.renamedTo` | Renamed to “{name}”. |
| `shell.renameMore` | Rename… |
| `shell.renameOrg` | Rename organization |
| `shell.renameOrgAbout` | Its people see the new name at once, everywhere. |
| `shell.sameSchema` | That's where it is now. |
| `shell.sayDollars` | Say how many dollars of credits. |
| `shell.schemaRule` | Lowercase letters, digits and _, starting with a letter. |
| `shell.searchOrgs` | Search organizations |
| `shell.searchPlaceholder` | Search by name, id, schema or maker |
| `shell.signedInAs` | Signed in as {who} |
| `shell.spaces` | Spaces |
| `shell.staff` | Staff |
| `shell.staffAccess` | Staff access |
| `shell.staffLine` | You're in this org as platform staff: what you do is on its record. |
| `shell.status` | Status |
| `shell.suspend` | Suspend |
| `shell.suspendAbout` | Nobody but staff goes in until you lift it: its people see that it's suspended. Nothing in it is changed or deleted. |
| `shell.suspended` | Suspended |
| `shell.suspendedTitle` | {name} is suspended: nobody goes in for now |
| `shell.suspendMore` | Suspend… |
| `shell.suspendTitle` | Suspend {name}? |
| `shell.switchingTo` | Switching to |
| `shell.switchOrg` | {name}: switch organization |
| `shell.switchTo` | Switch to {name} |
| `shell.takeBack` | Take back |
| `shell.takeBackAbout` | Nobody can claim it after this, and that can't be undone. If someone still needs it, make them a new one. |
| `shell.takeBackTitle` | Take back this {amount} code? |
| `shell.takeItBack` | Take it back |
| `shell.team` | Team |
| `shell.teamOrg` | Team org |
| `shell.teamOrgs` | Team orgs |
| `shell.termsLapse` | Credits lapse {lapse} |
| `shell.termsLapseClaim` | Credits lapse {lapse} · claim by {until} |
| `shell.termsNoLapse` | Credits don't lapse |
| `shell.termsNoLapseClaim` | Credits don't lapse · claim by {until} |
| `shell.tryAgain` | Try again |
| `shell.typeToConfirm` | Type {name} to confirm |
| `shell.unsupported` | This app doesn't do that yet. ({reason}) |
| `shell.whatFor` | What it's for |
| `shell.whatForHint` | Whoever claims it sees this in their history. |
| `shell.whichOrgs` | Which organizations |
| `shell.yourCode` | Your {amount} gift code |
| `shell.youreHere` | You're here |
| `shell.youreIn` | You're in {name} |
| `shell.yourOrgs` | Your organizations |
| `shell.yourOwn` | Your own |
| `shell.yourOwnOrg` | Your own org |
