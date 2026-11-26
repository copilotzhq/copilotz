# Front-end words

Every word Copilotz's web front ends show, by key, with its English. An app changes any of
them with a `words` resource (see the README, "Words"). `{name}` is a blank; a phrase in
braces `{one, other}` has plural forms, chosen by the `{count}` blank. Every one of them is
said in Brazilian Portuguese by `ptBR`, from `copilotz/web/pt-br` (hosts/web/pt-br/).

Generated: `deno run -A hosts/web/tests/keys.ts`.


## accounts

| Key | English |
|---|---|
| `accounts.about` | The AI plans you pay for, where they run, and your own API keys. Agents working for you use them; nobody else can: not the people you share spaces with, nor their agents. |
| `accounts.cancel` | Cancel |
| `accounts.closeTab` | You can close the sign-in tab. |
| `accounts.connect` | Connect |
| `accounts.connectedNotice` | {provider} is connected: agents working for you use it from now on. |
| `accounts.connectedTitle` | {provider} is connected |
| `accounts.connectsOnPaste` | It connects as soon as you paste it. |
| `accounts.connectTitle` | Connect {provider} |
| `accounts.continueTo` | Continue to {provider} |
| `accounts.dismiss` | Dismiss |
| `accounts.done` | Done |
| `accounts.elsewhere` | That's another page's address: it should start with {address} |
| `accounts.foot` | Sign-ins stay on the server, never shown in the app or to agents' models. Disconnecting ends them at the provider too. |
| `accounts.noClipboard` | This browser didn't let the page read what you copied: paste it here. |
| `accounts.nothing` | Nothing to connect yet |
| `accounts.nothingText` | This app doesn't offer accounts to connect. |
| `accounts.notYet` | That doesn't look like it yet: copy the whole address, from the address bar |
| `accounts.nowRuns` | Agents working for you now run on your {provider} plan. |
| `accounts.nowUses` | Agents working for you can now use your {provider} account. |
| `accounts.otherAccounts` | Other accounts |
| `accounts.paste` | Paste |
| `accounts.pasteHere` | Paste it here |
| `accounts.planOf` | {provider} {plan} plan |
| `accounts.reconnect` | Reconnect |
| `accounts.reconnectTitle` | Reconnect {provider} |
| `accounts.sentBack` | {provider} asks you to sign in and allow it, then sends you back here. |
| `accounts.signInAgain` | Open the sign-in again |
| `accounts.signInTo` | Sign in to {provider} |
| `accounts.startAgain` | Start again |
| `accounts.startFailed` | Couldn't start connecting: {why} |
| `accounts.stepLand` | You'll land on a page that doesn't load, at {address}. That's expected. Copy that page's whole address from the address bar. |
| `accounts.stepSignIn` | Sign in to {provider} and allow access. It opens in a new tab. |
| `accounts.title` | Your AI |
| `accounts.tryAgain` | Try again |

## chat

| Key | English |
|---|---|
| `chat.aConversation` | a conversation |
| `chat.addMessage` | Add a message, or just send it |
| `chat.agentsHere` | Agents here |
| `chat.agentsIn` | Agents in {space} |
| `chat.allChats` | All chats |
| `chat.anotherSpace` | another space |
| `chat.answerAlways` | Yes, always |
| `chat.answered` | What {agent} answered |
| `chat.answerHere` | Post here |
| `chat.answerMayDraw` | It may draw on things not everyone here can see. |
| `chat.answerMayDrawName` | It may draw on things {name} can't see. |
| `chat.answerMe` | Send it to me only |
| `chat.answerNo` | No |
| `chat.answerOnce` | Yes, this once |
| `chat.answerOrigin` | Yes, for this {kind} |
| `chat.answerRoutine` | Yes, for this routine |
| `chat.answers` | Answers |
| `chat.answerStayed` | The answer stayed where it was written. |
| `chat.answersWhereSeen` | {agents} will answer here, where {name} can read it. To look something up just for your team, ask in staff notes. |
| `chat.answerThread` | Yes, for this conversation |
| `chat.answerWentTo` | The answer went to {name} only. |
| `chat.archive` | Archive |
| `chat.archived` | Archived |
| `chat.archivedIn` | Archived, in {space} |
| `chat.archivedNone` | No archived chats here. |
| `chat.archivedNote` | It's listed apart, under Archived in its space's chats. A new message brings it back. |
| `chat.archivedTitle` | This chat is archived |
| `chat.archiveNewer` | Something new arrived in this conversation: see it, then archive it. |
| `chat.archiveThisChat` | Archive this chat |
| `chat.areWorking` | one: {names} is working… / other: {names} are working… |
| `chat.askBack` | Post {agent}'s answer here? |
| `chat.askedInSideThread` | Asked in a side thread |
| `chat.askerFor` | {agent} (for {name}) |
| `chat.askInNotes` | Ask in staff notes |
| `chat.askPost` | Post this to {place}? |
| `chat.asksCount` | one: {count} ask / other: {count} asks |
| `chat.askSend` | Send this to {place}? |
| `chat.attachFiles` | Attach files |
| `chat.bytes` | {n} B |
| `chat.cancel` | Cancel |
| `chat.cantRecord` | This browser can't record audio. |
| `chat.cantRecordHere` | This browser can't record audio here. |
| `chat.chatMore` | This chat: more |
| `chat.chats` | Chats |
| `chat.chatsWaiting` | one: {count} chat waiting on you / other: {count} chats waiting on you |
| `chat.close` | Close |
| `chat.connectionLostSr` | Connection lost. Trying again. |
| `chat.conversation` | Conversation |
| `chat.copyReply` | Copy reply |
| `chat.couldntAnswer` | Couldn't answer. |
| `chat.couldntRead` | Couldn't read it |
| `chat.couldntTranscribeAudio` | Couldn't transcribe the audio, so it wasn't sent |
| `chat.couldntTranscribeRecording` | Couldn't transcribe your recording, so it wasn't sent |
| `chat.couldntUpload` | Couldn't upload it |
| `chat.coversPost` | post to {place} |
| `chat.coversSend` | send to {place} |
| `chat.create` | Create |
| `chat.deleteRecording` | Delete recording |
| `chat.doingPost` | post this to {place} |
| `chat.doingPostAnswer` | post its answer in {place} |
| `chat.doingSend` | send this to {place} |
| `chat.doingSendAnswer` | send its answer to {place} |
| `chat.download` | Download {name} |
| `chat.downloadFile` | Download {name}, {size} |
| `chat.earlier` | Earlier |
| `chat.filesToSend` | Files to send |
| `chat.findSpace` | Find a space |
| `chat.goesTo` | one: Goes to {names} when it's done / other: Goes to {names} when they're done |
| `chat.greetingAfternoon` | Good afternoon |
| `chat.greetingAfternoonNamed` | Good afternoon, {name} |
| `chat.greetingEvening` | Good evening |
| `chat.greetingEveningNamed` | Good evening, {name} |
| `chat.greetingMorning` | Good morning |
| `chat.greetingMorningNamed` | Good morning, {name} |
| `chat.heldBack` | A reply only some here could see was held back. |
| `chat.heldFrom` | Held from {title} |
| `chat.heldMoved` | A reply only {name} could see was moved to their Personal space. |
| `chat.helpWith` | What can I help with? |
| `chat.homePlaceholder` | Ask anything; @name asks a particular agent |
| `chat.input` | Input |
| `chat.inSideThread` | in a side thread · |
| `chat.inSpace` | In {space} |
| `chat.inThisChat` | In this chat: {names} |
| `chat.jumpToLatest` | Jump to latest |
| `chat.keepWhereItIs` | Keep it where it is |
| `chat.keyEnter` | Enter |
| `chat.keyEsc` | Esc |
| `chat.keyShift` | Shift |
| `chat.keysHint` | {enter} to send · {shift} + {enter} for a new line |
| `chat.keywordArchive` | put away |
| `chat.keywordConversation` | conversation |
| `chat.keywordRestore` | unarchive |
| `chat.keywordSpace` | space |
| `chat.keywordStart` | start |
| `chat.keywordTitle` | change title |
| `chat.kilobytes` | {n} KB |
| `chat.latestAreHere` | The latest {count} are here. |
| `chat.latestChats` | Latest chats |
| `chat.letsAlways` | {agent} may {doing} without asking again, in any conversation. |
| `chat.letsHere` | It goes in this conversation, for everyone in it. |
| `chat.letsMe` | It goes to your Personal space, where only you see it. |
| `chat.letsNo` | {agent} is told no, and goes on without it. |
| `chat.letsOnce` | {agent} may {doing}, this once. |
| `chat.letsOrigin` | {agent} may {doing} without asking again, whenever “{name}” runs, until it's changed. It won't cover anything you ask it yourself. |
| `chat.letsThread` | {agent} may {doing} without asking again, in this conversation. |
| `chat.megabytes` | {n} MB |
| `chat.message` | Message |
| `chat.messageAgents` | Message {names} |
| `chat.messageByTo` | {author} to {to} |
| `chat.messageCount` | one: {count} message / other: {count} messages |
| `chat.messaged` | Messaged {names} |
| `chat.messages` | Messages |
| `chat.messageTheAgents` | Message the agents |
| `chat.messaging` | Messaging {names} |
| `chat.micBlocked` | Microphone access is blocked. Allow it for this site in your browser's settings, then try again. |
| `chat.micBusy` | The microphone is busy in another app. Close it there, then try again. |
| `chat.micCouldntStart` | The microphone couldn't start. |
| `chat.micNotFound` | No microphone was found. Connect one, then try again. |
| `chat.missingBody` | It may have moved, or it isn't shared with you. Someone in it can invite you to its space. |
| `chat.missingTitle` | This chat isn't here |
| `chat.moreWaiting` | one: and {count} more chat waiting on you / other: and {count} more chats waiting on you |
| `chat.moveConfirm` | Move “{title}” to {space}? |
| `chat.moveNote` | Its messages, files and subthreads go with it, for the people in that space to see. |
| `chat.moveThisChat` | Move this chat to another space… |
| `chat.moveTitle` | Move “{title}” to… |
| `chat.moveTo` | Move to {space} |
| `chat.moveToSpace` | Move to another space… |
| `chat.movingDrew` | It drew on {spaces}. |
| `chat.movingEveryone` | one: Everyone in {space} ({count} person) will see this whole conversation. / other: Everyone in {space} ({count} people) will see this whole conversation. |
| `chat.movingEveryoneThere` | Everyone in {space} will see this whole conversation. |
| `chat.movingTheirs` | {name} will see this whole conversation, in their Personal space. |
| `chat.movingYours` | Only you will see this conversation, in your Personal space. |
| `chat.namesAnd` | {rest} and {last} |
| `chat.needsYourOk` | {agent} needs your OK |
| `chat.newChat` | New chat |
| `chat.newChatHere` | New chat here |
| `chat.newChatIn` | New chat in… |
| `chat.newMessages` | New messages |
| `chat.noChatsBody` | Start one: its agents work with what's in this space, and whoever's in it can follow along. |
| `chat.noChatsMatch` | No chats match “{search}”. |
| `chat.noChatsTitle` | No chats here yet |
| `chat.noChatsYet` | No chats yet |
| `chat.noSpeech` | No speech was heard. |
| `chat.notesAbout` | Staff notes about the conversation with {name} |
| `chat.notesArchivedTitle` | Archived, with the chat they're about |
| `chat.notesAsPage` | Open staff notes as a page |
| `chat.notesClose` | Close staff notes |
| `chat.notesEmptyBody` | Ask an agent to look something up or draft a reply, or leave a note for whoever picks this up. Nothing here reaches {name}. |
| `chat.notesEmptyTitle` | Your team's side of this conversation |
| `chat.notesNever` | Only your team sees this, never {name} |
| `chat.notesOf` | Staff notes: {title} |
| `chat.notesOnlyTeam` | Only your team sees this |
| `chat.notesPlaceholder` | Ask an agent or leave a note for your team… |
| `chat.notesTitle` | Staff notes |
| `chat.notesViews` | The conversation, or its staff notes |
| `chat.notesWithCount` | one: Staff notes, {count} message / other: Staff notes, {count} messages |
| `chat.notFoundTitle` | Not found |
| `chat.notInSpace` | You're not in this space |
| `chat.notInSpaceBody` | Chats here are for its members. Pick one of your spaces to start one, or ask someone here to invite you. |
| `chat.notYourSpaceTitle` | Not your space |
| `chat.ofMinutes` | one: , of {count} minute at most / other: , of {count} minutes at most |
| `chat.open` | Open {name} |
| `chat.openChat` | Open chat |
| `chat.openConversation` | Open conversation |
| `chat.openNotes` | Open staff notes |
| `chat.openSpace` | Open {space} |
| `chat.otherSpaces` | one: {count} other space / other: {count} other spaces |
| `chat.overLimit` | Over 10 MB |
| `chat.pastedFile` | pasted file |
| `chat.personal` | Personal |
| `chat.reading` | Reading… |
| `chat.reconnecting` | reconnecting |
| `chat.recordAgain` | Record again |
| `chat.recorded` | Recorded |
| `chat.recordingAria` | Recording a voice message |
| `chat.recordingSr` | Recording. Escape cancels. |
| `chat.recordingsStopAt` | one: Recordings stop at {count} minute. Listen back, or send it. / other: Recordings stop at {count} minutes. Listen back, or send it. |
| `chat.recordingStopped` | The recording stopped unexpectedly. Try again. |
| `chat.recordVoice` | Record a voice message |
| `chat.remove` | Remove {name} |
| `chat.rename` | Rename… |
| `chat.renameNote` | Everyone who sees this chat sees its new title. |
| `chat.renamePlaceholder` | Its new title |
| `chat.renameThisChat` | Rename this chat… |
| `chat.renameTitle` | Rename “{title}” |
| `chat.renameTo` | Rename to “{title}” |
| `chat.restore` | Restore |
| `chat.restoreThisChat` | Restore this chat |
| `chat.result` | Result |
| `chat.retry` | Retry |
| `chat.retrying` | Retrying… |
| `chat.retryingIn` | Connection lost, retrying in {seconds} s |
| `chat.retryNumber` | retry {attempt} |
| `chat.rowMore` | {title}: more |
| `chat.searchChats` | one: Search {count} chat / other: Search {count} chats |
| `chat.searchChatsLabel` | Search chats |
| `chat.seenByMembers` | one: Its one member will see it. / other: Its {count} members will see it. |
| `chat.seenByName` | {name} will see it. |
| `chat.send` | Send |
| `chat.sendAudioOnly` | Send audio only |
| `chat.sendMessage` | Send a message |
| `chat.sendNow` | Send now |
| `chat.sendsAsYou` | It goes as you, and {name} will see it. |
| `chat.sendToName` | Send to {name}… |
| `chat.sendToNameNow` | Send to {name} |
| `chat.sentTo` | Sent to {name} |
| `chat.sharedWith` | Shared with {name} |
| `chat.showTranscript` | Show transcript |
| `chat.sideThread` | side thread |
| `chat.startingMic` | Starting the microphone… |
| `chat.startingMicSr` | Starting the microphone. |
| `chat.startNewChat` | Start a new chat |
| `chat.startsInPersonal` | Starts in Personal, just for you |
| `chat.startsInSpace` | Starts in {space}, for its members |
| `chat.stillWaking` | Still waking the computer… |
| `chat.stop` | Stop |
| `chat.stopped` | Stopped |
| `chat.stopping` | Stopping… |
| `chat.stopToSendNow` | Stop to send now |
| `chat.suggestions` | Suggestions |
| `chat.theirPersonalSpace` | {name}'s Personal space |
| `chat.thinking` | thinking |
| `chat.thinkingLabel` | Thinking |
| `chat.thisChat` | this chat |
| `chat.thisChatGroup` | This chat |
| `chat.thisMonth` | This month |
| `chat.thisWeek` | This week |
| `chat.timeLeft` | {time} left |
| `chat.titleAtMost` | At most {count} characters |
| `chat.to` | to |
| `chat.today` | Today |
| `chat.tooShort` | That was too short to send. Hold on a moment longer. |
| `chat.transcribingAudio` | Transcribing the audio… |
| `chat.transcribingRecording` | Transcribing your recording… |
| `chat.transcript` | Transcript |
| `chat.tryAgain` | Try again |
| `chat.uploading` | Uploading… |
| `chat.used` | Used {names} |
| `chat.using` | Using {names} |
| `chat.viaAnswer` | Answer: {name} |
| `chat.viaDelegated` | Delegated: {name} |
| `chat.viaOther` | {kind}: {name} |
| `chat.viaRoutine` | Routine: {name} |
| `chat.voiceMessage` | Voice message |
| `chat.waitingOnAnswer` | Waiting on your answer: your next message replies. |
| `chat.waitingOnYou` | Waiting on you |
| `chat.waking` | Waking the computer… |
| `chat.wakingAbout` | one: Waking the computer… (about {count} second) / other: Waking the computer… (about {count} seconds) |
| `chat.wakingSlower` | one: Waking the computer… (about {count} second: it takes longer at this hour) / other: Waking the computer… (about {count} seconds: it takes longer at this hour) |
| `chat.wakingStatus` | waking its computer |
| `chat.wantsTo` | {agent} wants to {doing} |
| `chat.welcomeBack` | Back |
| `chat.welcomeDone` | Get started |
| `chat.welcomeNext` | Next |
| `chat.welcomeStep` | {at} of {count} |
| `chat.why` | Why: {reason} |
| `chat.working` | working |
| `chat.workingIn` | What are we working on in {space}? |
| `chat.workMayDraw` | {agent}'s work here may draw on things not everyone there can see. |
| `chat.workMayDrawName` | {agent}'s work here may draw on things {name} can't see. |
| `chat.wouldDo` | What it would do |
| `chat.wouldPost` | What {agent} would post |
| `chat.wouldSend` | What {agent} would send |
| `chat.writing` | writing |
| `chat.writingLabel` | {name}, writing |
| `chat.yesterday` | Yesterday |
| `chat.you` | you |
| `chat.youLabel` | You |
| `chat.yourContact` | your contact |
| `chat.yourMessageTo` | Your message to {name} |
| `chat.yourPersonalSpace` | your Personal space |
| `chat.yourRecording` | Your recording |

## computers

| Key | English |
|---|---|
| `computers.antigravityCli` | Antigravity |
| `computers.antigravityTitle` | Google AI plan, through Antigravity |
| `computers.awakeHours` | {hours}h {minutes}m |
| `computers.awakeMinutes` | {minutes}m |
| `computers.cancel` | Cancel |
| `computers.cardAsleep` | asleep: it wakes when your agents need it |
| `computers.cardAway` | one: Signed in on {computers}, which is off. Your agents use the app's models until it's on. / other: Signed in on {computers}, which are off. Your agents use the app's models until one is on. |
| `computers.cardLimited` | At its limit since {time}: your agents use your next plan, or the app's models, until it resets. |
| `computers.cardOff` | Not connected: your agents use the app's models. |
| `computers.cardOnline` | online |
| `computers.cardReady` | Running on {computer} ({state}). |
| `computers.cardReadyBackup` | Running on {computer} ({state}), with {backup} ready as backup. |
| `computers.cardReadyServer` | Connected as {account}, on the server: always ready. |
| `computers.cardReconnect` | {plan} needs you to sign in again. |
| `computers.checkAgain` | Check again |
| `computers.checkFailed` | Couldn't check your computers: {why} |
| `computers.claudeCli` | Claude Code |
| `computers.claudeTitle` | Claude plan |
| `computers.close` | Close |
| `computers.codeHint` | If the page shows a code once you've signed in, paste it here. |
| `computers.codeLabel` | The code from the sign-in page |
| `computers.codePlaceholder` | Paste the code |
| `computers.codeSent` | Code sent: finishing… |
| `computers.codexCli` | Codex |
| `computers.codexTitle` | ChatGPT plan, through Codex |
| `computers.connect` | Connect |
| `computers.copyCode` | Copy the code |
| `computers.costCoversMonth` | one: Your {amount} a month covers about {count} hour of work, after the disk. / other: Your {amount} a month covers about {count} hours of work, after the disk. |
| `computers.costCoversOnce` | one: Your {amount} covers about {count} hour of work, after this month's disk. / other: Your {amount} covers about {count} hours of work, after this month's disk. |
| `computers.costHour` | one: About {price} per hour of work, and it sleeps {count} minute after. / other: About {price} per hour of work, and it sleeps {count} minutes after. |
| `computers.costMonth` | This month: {awake} awake · {price} · disk {disk} |
| `computers.costMonthNoDisk` | This month: {awake} awake · {price} |
| `computers.cursorCli` | Cursor |
| `computers.cursorTitle` | Cursor plan |
| `computers.done` | Done |
| `computers.dropTitle` | Drop to upload |
| `computers.dropTo` | To {folder} on {computer} |
| `computers.failInstall` | {cli} didn't install on {computer}. What its installer said is below. |
| `computers.failShared` | {computer} is shared with others' agents, so plans can't run on it. |
| `computers.failSignIn` | Signing in to {plan} didn't finish. |
| `computers.failTest` | {plan} didn't answer: {why} |
| `computers.failWindows` | Install {cli} on {computer} from its terminal, once: |
| `computers.filesDownload` | Download {name} |
| `computers.filesEmpty` | Nothing here yet |
| `computers.filesEmptyDrop` | Drop files here to upload them. What you and your agents make in this folder shows up here too. |
| `computers.filesEmptyText` | What you and your agents make in this folder shows up here. |
| `computers.filesFilter` | Filter |
| `computers.filesFilterLabel` | Filter this folder |
| `computers.filesIn` | In {folder} |
| `computers.filesItsOwner` | its owner |
| `computers.filesJustUploaded` | uploaded |
| `computers.filesNoMatch` | Nothing here matches “{filter}”. |
| `computers.filesOn` | {folder}, on {computer} |
| `computers.filesRefresh` | Refresh |
| `computers.filesUpTo` | Up to {folder} |
| `computers.filesViewOnly` | Only {owner} changes files on {computer} here. You can open and download them. |
| `computers.filesWhere` | Where in the folder |
| `computers.fix` | Fix |
| `computers.flowConnected` | Connected |
| `computers.flowDone` | Your agents now run on {plans}. |
| `computers.flowTitle` | Connect your plans |
| `computers.flowWhere` | Where should they run? |
| `computers.flowWhereAbout` | {plans} run through an app on a computer. We set it up, and keep it up to date. |
| `computers.folderDropped` | “{name}” is a folder, and folders can't be uploaded. Drop the files in it, or a zip of it. |
| `computers.foldersDropped` | one: {count} folder wasn't uploaded: folders can't be. Drop the files in it, or a zip of it. / other: {count} folders weren't uploaded: folders can't be. Drop the files in them, or a zip of each. |
| `computers.grokCli` | Grok Build |
| `computers.grokTitle` | Grok plan |
| `computers.installCommand` | The command that installs {cli} |
| `computers.keepBoth` | Keep both |
| `computers.lineAnswered` | It answered: “{text}” |
| `computers.lineComputer` | {computer} is ready |
| `computers.lineGetting` | Getting {computer} ready… |
| `computers.lineInstalling` | Installing {cli} on {computer}… |
| `computers.lineLimit` | Connected. Your {plan} is at its limit right now: your agents use it again when it resets. |
| `computers.lineTesting` | Asking it a short question… |
| `computers.lineWaking` | Waking {computer}… (about 30 seconds) |
| `computers.listMore` | {rest} and {last} |
| `computers.listPair` | {first} and {second} |
| `computers.makeFailed` | Couldn't make your cloud computer: {why} |
| `computers.making` | Making your cloud computer… |
| `computers.moreFor` | More for {plan} |
| `computers.moveUp` | Move up |
| `computers.newFile` | New file |
| `computers.newFileMake` | Make the file |
| `computers.newFileName` | The new file's name |
| `computers.newFilePlaceholder` | notes.md, or src/new.ts |
| `computers.notConnected` | not connected |
| `computers.offline` | Offline |
| `computers.online` | Online |
| `computers.openSignIn` | Open the sign-in page |
| `computers.openTerminal` | Open {computer}'s terminal |
| `computers.orderAbout` | When a model runs on more than one of your plans, your agents try them in this order. |
| `computers.orderFailed` | Couldn't save the order: {why} |
| `computers.orderTitle` | Use my plans in this order |
| `computers.orInstall` | Or install it from {computer}'s terminal, then check again: |
| `computers.output` | What {cli} says |
| `computers.paletteConnect` | Connect your {plan} |
| `computers.paletteGroup` | General |
| `computers.paletteKeywords` | plan, subscription, sign in, computer, Claude, ChatGPT, Codex, Gemini, Google, Grok, Cursor |
| `computers.plansAbout` | Your agents run on AI plans you already pay for, instead of the app's models. Connect each one once, and it works in every conversation and space here. |
| `computers.plansCloud` | A cloud computer you use for it is charged while it's awake. |
| `computers.plansPaid` | Your plan pays for the AI. |
| `computers.plansPrivate` | Sign-ins stay on your computers, or sealed on the server: nobody else sees them. |
| `computers.plansTitle` | Your plans |
| `computers.recommended` | Recommended |
| `computers.replace` | Replace |
| `computers.replaceAll` | one: Do the same for the other file that's already there / other: Do the same for the other {count} files that are already there |
| `computers.replaceFolderText` | A file can't replace a folder. Upload yours beside it under another name, or skip it. |
| `computers.replaceFolderTitle` | There's a folder named “{name}” |
| `computers.replaceKeepAs` | Keep both uploads yours as “{name}”. |
| `computers.replaceText` | {folder} already has a file named “{name}”. Replacing it puts yours in its place. |
| `computers.replaceThere` | The one there: {size}, changed {time} |
| `computers.replaceTitle` | Replace “{name}”? |
| `computers.replaceYours` | Yours: {size}, changed {time} |
| `computers.seenAt` | last seen {time} |
| `computers.send` | Send |
| `computers.shareOwnWarning` | Agents in {space} run on {computer} as you: they can read everything you can on it, including your own sign-ins (Claude Code, Codex, SSH keys). Share it only with people you trust. |
| `computers.shareSignedIn` | {computer} is signed in to your {plan}. Sign out of it first: a computer shared with others can't keep plan sign-ins. |
| `computers.signOutFailed` | Couldn't sign out of {computer}: {why} |
| `computers.signOutOn` | Sign out on {computer} |
| `computers.signOutServer` | Disconnect {plan} |
| `computers.skip` | Skip |
| `computers.stepEnterCode` | Open the sign-in page, sign in with the account that has your plan, and enter this code there: |
| `computers.stepSaved` | Saved {file} to {path} |
| `computers.stepSaves` | Saves {file} to {path} |
| `computers.stepSavesFile` | Saves a file from this chat to {path} |
| `computers.stepSavesFolder` | Saves a file from this chat in the space's folder |
| `computers.stepSends` | Sends {path} to this chat |
| `computers.stepSent` | Sent {file} |
| `computers.stepSignInHere` | Open the sign-in page, and sign in with the account that has your plan. |
| `computers.stepSignInWait` | The sign-in page shows here as soon as {cli} gives it. |
| `computers.terminal` | Terminal |
| `computers.tryAgain` | Try again |
| `computers.upload` | Upload |
| `computers.uploadAsking` | There's one by this name already |
| `computers.uploadCancel` | Cancel uploading {name} |
| `computers.uploadCancelled` | Cancelled |
| `computers.uploadDone` | Uploaded |
| `computers.uploadDoneAs` | Uploaded as {name} |
| `computers.uploadFailed` | It didn't upload. Try again. |
| `computers.uploadFinishing` | Saving on {computer}… |
| `computers.uploadFolderThere` | There's a folder by that name, and a file can't replace it. |
| `computers.uploadForbidden` | You can't change files on this computer. |
| `computers.uploadFull` | There's no room left on {computer}'s disk. |
| `computers.uploadIn` | in {folder} |
| `computers.uploading` | one: Uploading {count} file / other: Uploading {count} files |
| `computers.uploadInvalid` | That name can't be used here. |
| `computers.uploadNetwork` | The connection dropped. Try again. |
| `computers.uploadNoLength` | The browser didn't say how big it is. Try again. |
| `computers.uploadNotFound` | This computer isn't in this space anymore. |
| `computers.uploadNoWake` | {computer} didn't wake up in time. Try again. |
| `computers.uploadOffline` | {computer} is offline. Try again once it's on. |
| `computers.uploadOpen` | Open {name} |
| `computers.uploadOutdated` | {computer}'s computer program is too old to take uploads. It updates itself, or its owner updates it: then try again. |
| `computers.uploadProgress` | {done} of {total} |
| `computers.uploadProgressLabel` | Uploading {name} |
| `computers.uploadQueued` | Waiting to upload |
| `computers.uploadReplaced` | Uploaded in place of the one there |
| `computers.uploadRestart` | This upload was interrupted and has to start again. |
| `computers.uploads` | Uploads |
| `computers.uploadsAsking` | one: {count} waits for you / other: {count} wait for you |
| `computers.uploadsCancelAll` | Cancel all |
| `computers.uploadsDone` | one: {count} file uploaded / other: {count} files uploaded |
| `computers.uploadsFailed` | one: {count} didn't upload / other: {count} didn't upload |
| `computers.uploadsHide` | Hide uploads |
| `computers.uploadSignedOut` | You're signed out. Sign in again, then try again. |
| `computers.uploadSkipped` | Skipped: the one there stays |
| `computers.uploadsLeft` | {size} left |
| `computers.uploadTooLarge` | It's {size}: a file can be {most} at most. |
| `computers.uploadTooLargeHere` | It's {size}: too large to send through this app. |
| `computers.uploadUnavailable` | {computer} couldn't wake up. Try again in a moment. |
| `computers.uploadWaiting` | Waiting for {computer}… |
| `computers.uploadWaking` | Waking {computer}… |
| `computers.useCloud` | Use a cloud computer |
| `computers.welcomeConnect` | Connect them |
| `computers.welcomeLater` | You can connect them later, in Your AI. |
| `computers.welcomeNone` | None of these |
| `computers.welcomeNoneThen` | Your agents use the app's models. |
| `computers.whereCloud` | In the cloud |
| `computers.whereCloudAbout` | Always ready. It sleeps when your agents aren't working, and you pay only while it's awake. |
| `computers.whereLocal` | On this computer |
| `computers.whereLocalAbout` | Free. Works while this computer is on. Needs one line in your terminal, once. |
| `computers.whereNone` | Open this page on your computer to connect it. |
| `computers.yoursAbout` | Where your plans run, and your agents' work. |
| `computers.yoursNone` | No computer yet. A plan that runs through its app needs one: connecting it sets one up for you. |
| `computers.yoursServes` | Runs {plans} |
| `computers.yoursServesNone` | No plans signed in here |
| `computers.yoursTitle` | Your computers |

## host

| Key | English |
|---|---|
| `host.couldntComeIn` | Couldn't come in |
| `host.couldntConnect` | Couldn't connect |
| `host.couldntRead` | Couldn't read |
| `host.failedTitle` | Something went wrong here |
| `host.forbidden` | It isn't shared with you, or it only shows inside another page. |
| `host.forbiddenTitle` | You can't see this here |
| `host.hostSilent` | The host didn't answer |
| `host.later` | Later |
| `host.loading` | Loading |
| `host.newVersion` | A new version of {app} is ready |
| `host.newVersionHint` | Reload to use it; nothing you've done is lost. |
| `host.noHost` | No host |
| `host.notOffered` | {action} isn't offered in this widget |
| `host.reload` | Reload |
| `host.signedOut` | Signed out |
| `host.widgetCantCall` | This widget can't call its app here |

## memory

| Key | English |
|---|---|
| `memory.aboutAgent` | About {name} |
| `memory.aboutChats` | About particular chats |
| `memory.aboutEveryone` | About everyone |
| `memory.aboutOneChat` | About a chat |
| `memory.aboutPerson` | About {name} |
| `memory.aboutYou` | About you |
| `memory.all` | All |
| `memory.allMemories` | All memories |
| `memory.by` | By {name} |
| `memory.chat` | Chat |
| `memory.core` | Core |
| `memory.coreHint` | Core: always in mind |
| `memory.coreMemories` | Core memories |
| `memory.coreSr` | Core: |
| `memory.emptyBody` | As you talk, agents keep here what will matter later: who you are, what you prefer, what you decided. |
| `memory.emptyTitle` | Nothing remembered yet |
| `memory.findMemory` | Find a memory |
| `memory.findSpace` | Find a space |
| `memory.memories` | Memories |
| `memory.moreMenu` | This memory: more |
| `memory.moveNote` | Agents then recall it as learned there, for the people in that space. |
| `memory.moveOne` | Move a memory to another space… |
| `memory.moveOneTitle` | Move a memory… |
| `memory.moveThis` | Move this memory to another space… |
| `memory.moveTitle` | Move “{memory}” to… |
| `memory.moveToSpace` | Move to another space… |
| `memory.noCore` | No core memories yet. |
| `memory.noMatch` | No memories match “{search}”. |
| `memory.notedFromChat` | Noted from the chat |
| `memory.pageIntro` | What agents remember across chats. {star} Core memories are always in mind; the rest come up when they're relevant. |
| `memory.personalSpace` | Personal |
| `memory.searchMemories` | Search memories |
| `memory.spaceIntro` | What agents learned in this space. {star} Core memories are always in mind; the rest come up when they're relevant. |
| `memory.startChat` | Start a chat |
| `memory.thisMemory` | This memory |
| `memory.thisSpace` | This space |
| `memory.updated` | updated |
| `memory.was` | Was: {text} |
| `memory.whichMemories` | Which memories |

## palette

| Key | English |
|---|---|
| `palette.back` | Back |
| `palette.cancel` | Cancel |
| `palette.commandPalette` | Command palette |
| `palette.commands` | Commands |
| `palette.done` | Done |
| `palette.noResults` | No results |
| `palette.nothingFound` | Nothing found for “{search}” |
| `palette.nothingYet` | Nothing here yet |
| `palette.results` | one: {count} result / other: {count} results |
| `palette.search` | Search |
| `palette.searchOrCommand` | Search, or type a command |
| `palette.toChoose` | to choose |
| `palette.toClose` | to close |
| `palette.toGoBack` | to go back |
| `palette.toMove` | to move |

## push

| Key | English |
|---|---|
| `push.about` | When something waits on you (an agent asking for your yes, a reply in a chat you started, someone writing to you) and the app isn't open, we tell you on the devices you turn them on for. Nothing while you're looking at the app. |
| `push.blocked` | Notifications are blocked for this app in your browser's settings. Allow them there, then come back. |
| `push.install` | On iPhone and iPad, notifications come only to the app on your Home Screen: tap Share, then Add to Home Screen, open it from there and turn them on. |
| `push.notSetUp` | Notifications aren't set up in this app yet. |
| `push.off` | Off |
| `push.offText` | Turn them on to be told here when something waits on you. |
| `push.on` | On |
| `push.onText` | You'll be told here when something waits on you. |
| `push.others` | Your devices |
| `push.othersEmpty` | No device has notifications on yet. |
| `push.remove` | Turn off for {device} |
| `push.since` | on since {when} |
| `push.thisDevice` | On this device |
| `push.thisOne` | this device |
| `push.title` | Notifications |
| `push.turnOff` | Turn off |
| `push.turnOn` | Turn on |
| `push.unsupported` | This browser can't show notifications from the app. |

## shell

| Key | English |
|---|---|
| `shell.addYourName` | Add your name |
| `shell.cancel` | Cancel |
| `shell.close` | Close |
| `shell.closeSidebar` | Close sidebar |
| `shell.collapseSidebar` | Collapse sidebar |
| `shell.expandSidebar` | Expand sidebar |
| `shell.general` | General |
| `shell.goHome` | Go home |
| `shell.hidePanel` | Hide the panel |
| `shell.hidePanelTitled` | Hide the {title} panel |
| `shell.homeOf` | {brand}: home |
| `shell.keysPanel` | side panel toggle |
| `shell.keysSidebar` | sidebar rail fold unfold hide show toggle |
| `shell.nameAbout` | How people and agents here see you. |
| `shell.nameEmpty` | Leave it empty to go by your email. |
| `shell.nameLabel` | Name |
| `shell.nameNotSaved` | Your name wasn't saved. {reason} |
| `shell.nameTryAgain` | Your name wasn't saved. Try again in a moment. |
| `shell.nothingHere` | Nothing here |
| `shell.nothingOpens` | This address doesn't open anything. |
| `shell.nothingToShow` | Nothing to show |
| `shell.nothingToShowAbout` | There's no page for this here, or it isn't shared with you. |
| `shell.openSidebar` | Open sidebar |
| `shell.panel` | Panel |
| `shell.panelWidth` | Panel width |
| `shell.roleAdmin` | Admin |
| `shell.roleAdminLets` | Invites people, changes roles, and reaches everything in the org |
| `shell.roleGuest` | Guest |
| `shell.roleGuestLets` | Reaches only the spaces they're invited to |
| `shell.roleMember` | Member |
| `shell.roleMemberLets` | Works in their spaces, makes new ones, and sees who's in the org |
| `shell.roleOwner` | Owner |
| `shell.roleOwnerLets` | Runs the org: everything admins do, and makes or unmakes owners |
| `shell.save` | Save |
| `shell.search` | Search |
| `shell.searchTitle` | Search spaces and chats, or run a command ({shortcut}) |
| `shell.showPanel` | Show the panel |
| `shell.showPanelTitled` | Show the {title} panel |
| `shell.sidebar` | Sidebar |
| `shell.signedIn` | Signed in |
| `shell.signOut` | Sign out |
| `shell.skipToContent` | Skip to content |
| `shell.spacesAndChats` | Spaces and chats |
| `shell.yourAccount` | Your account |
| `shell.yourName` | Your name |

## spaces

| Key | English |
|---|---|
| `spaces.aboutLabel` | About |
| `spaces.acrossOrg` | Across the org |
| `spaces.acrossOrgHint` | The org's other spaces: you reach them by running it, not as a member |
| `spaces.addAgent` | Add an agent |
| `spaces.addAgentAbout` | Agents work for whoever asks them, and reach only what that person can. |
| `spaces.addAgentTitle` | Add an agent to {name} |
| `spaces.addSend` | one: Add {who} and send / other: Add them and send |
| `spaces.agentEditorLets` | Answers chats here, and adds notes, memories and files |
| `spaces.agents` | Agents |
| `spaces.agentsAboutPersonal` | They work here for you. One answers new chats; @name asks another. |
| `spaces.agentsAboutShared` | They work for whoever asks them, and reach only what that person can. One answers new chats; @name asks another. |
| `spaces.agentsCount` | one: {count} agent / other: {count} agents |
| `spaces.agentViewerLets` | Reads what's here for chats elsewhere; doesn't answer here |
| `spaces.anAgent` | An agent |
| `spaces.anRole` | an {role} |
| `spaces.answersAbout` | Who answers a chat started here. Anyone can still ask another agent with @name. |
| `spaces.answersLabel` | The agent that answers new chats |
| `spaces.answersNew` | Answers new chats |
| `spaces.answersNone` | No agent works here: chats here have no one to answer them. |
| `spaces.answersNow` | {name} answers new chats here now. |
| `spaces.answersViewersOnly` | Its agents only read here (viewers): make one an editor, in Members, to answer chats. |
| `spaces.appAgent` | One of the app's agents |
| `spaces.archiveAbout` | When the work here is done: everything stays as it was, and readable, and the space is listed apart, under Archived. Restore it any time. |
| `spaces.archiveApartLead` | It's listed apart, |
| `spaces.archiveApartRest` | under Archived in the sidebar, and agents in other spaces' chats stop looking in it. |
| `spaces.archiveBackLead` | It comes back as it was: |
| `spaces.archiveBackRest` | anyone who manages it can restore it, any time. |
| `spaces.archived` | Archived |
| `spaces.archivedAt` | Archived {time}. It's listed apart, and readable as it was; restored, it's listed with the others again. |
| `spaces.archivedNote` | It stays readable, as it was, and it's listed apart, under Archived. |
| `spaces.archiveMenu` | Archive… |
| `spaces.archiveNamed` | Archive {name} |
| `spaces.archiveNamedMore` | Archive {name}… |
| `spaces.archiveNote` | It stays readable, as it is, and it's listed apart, under Archived. Restore it any time. |
| `spaces.archiveReadableLead` | It stays readable. |
| `spaces.archiveReadableRest` | Its chats, memories and computers stay as they are, for everyone in it. |
| `spaces.archiveSetting` | Archive |
| `spaces.archiveTitle` | Archive {name}? |
| `spaces.aRole` | a {role} |
| `spaces.asked` | They asked to join. |
| `spaces.askedBy` | {by} asked for them to join. |
| `spaces.askedByWhy` | {by} asked for them: “{reason}” |
| `spaces.askedWhy` | They asked: “{reason}” |
| `spaces.askManagersAdd` | one: Your message wasn't sent. Ask someone who manages {where} to add it, or send it without the @. / other: Your message wasn't sent. Ask someone who manages {where} to add them, or send it without the @. |
| `spaces.askManagersEditor` | one: Your message wasn't sent. Ask someone who manages {where} to make it an editor, or send it without the @. / other: Your message wasn't sent. Ask someone who manages {where} to make them editors, or send it without the @. |
| `spaces.atMost` | At most {count} characters |
| `spaces.byAs` | By {by} · as {role} |
| `spaces.cancel` | Cancel |
| `spaces.copyOrgId` | Copy the org's id |
| `spaces.copySpaceId` | Copy the space's id |
| `spaces.createGroup` | Create |
| `spaces.createNamed` | Create “{name}” |
| `spaces.decline` | Decline |
| `spaces.declineInvitation` | Decline the invitation to {name} |
| `spaces.details` | Details |
| `spaces.done` | Done |
| `spaces.edit` | Edit {name} |
| `spaces.emailPlaceholder` | name@example.com |
| `spaces.general` | General |
| `spaces.goHome` | Go home |
| `spaces.heirHint` | They become its manager there. Spaces others manage too stay as they are. |
| `spaces.heirLabel` | Shared spaces only they manage go to |
| `spaces.hideIn` | Hide what's in {name} |
| `spaces.hideWhat` | Hide {name}'s {what} |
| `spaces.id` | Id |
| `spaces.invitations` | Invitations |
| `spaces.invitationsWaiting` | one: {count} invitation to a space / other: {count} invitations to spaces |
| `spaces.invitationTo` | Invitation to {name} |
| `spaces.invite` | Invite |
| `spaces.inviteAbout` | They'll see what's in it (its chats, memories and computers) and work with its agents. |
| `spaces.invitedAt` | Invited {time}. Joining shows you its chats, memories and computers. |
| `spaces.invitedBy` | Invited by {by} {time} |
| `spaces.invitedByYou` | Invited by you {time} |
| `spaces.invitedHeading` | Invited |
| `spaces.invitedMany` | Invited {emails}. Each joins once they accept. |
| `spaces.invitedNotJoined` | Invited, not joined yet |
| `spaces.invitedOne` | Invited {emails}. They'll join once they accept. |
| `spaces.invitedTime` | Invited {time} |
| `spaces.invitedTo` | Invited to {space} |
| `spaces.invitedYou` | {by} invited you to {space}, as {role}. |
| `spaces.invitedYouAs` | {by} invited you, as {role} |
| `spaces.inviteHint` | {lets}. Several? Separate them with commas. |
| `spaces.inviteHintMany` | {lets}. {count} addresses. |
| `spaces.invitePeople` | Invite people |
| `spaces.inviteSomeone` | Invite someone |
| `spaces.inviteTitle` | Invite someone to {name} |
| `spaces.inviteToNamed` | Invite someone to {name}… |
| `spaces.isArchived` | {name} is archived |
| `spaces.join` | Join |
| `spaces.joinNamed` | Join {name} |
| `spaces.justYou` | Just you |
| `spaces.keepIt` | Keep it as it is |
| `spaces.keysAcceptInvitation` | invitation accept |
| `spaces.keysCreate` | create make |
| `spaces.keysInvitation` | invitation |
| `spaces.keysInvite` | people member email add |
| `spaces.keysNewSpace` | create make shared |
| `spaces.keysPersonal` | personal mine |
| `spaces.keysPick` | personal |
| `spaces.keysRestore` | unarchive archived |
| `spaces.kind` | Kind |
| `spaces.kindPeople` | People |
| `spaces.kindPersonal` | Personal: yours alone |
| `spaces.kindTeam` | Team |
| `spaces.leave` | Leave |
| `spaces.leaveAbout` | You'll no longer see its chats, memories or computers; what you added stays here. |
| `spaces.leaveMenu` | Leave… |
| `spaces.leaveNamed` | Leave {name} |
| `spaces.leaveNamedMore` | Leave {name}… |
| `spaces.leaveNote` | You'll no longer see its chats, memories or computers; what you added stays there. To come back, someone who manages it invites you again. |
| `spaces.leaveThisSpace` | Leave this space |
| `spaces.leaveTitle` | Leave {name}? |
| `spaces.letIn` | Let in |
| `spaces.listMore` | {rest} and {last} |
| `spaces.listPair` | {first} and {second} |
| `spaces.madeElsewhere` | Made in another space |
| `spaces.madeIn` | Made in {space} |
| `spaces.makeAnswer` | Make it answer new chats |
| `spaces.makeEditorsSend` | one: Make {who} an editor and send / other: Make them editors and send |
| `spaces.makeSpace` | Make the space |
| `spaces.managersAdd` | Those who manage {name} add people to it. |
| `spaces.managersAddThis` | Those who manage this space add people to it. |
| `spaces.managersChange` | Those who manage {name} change its settings. |
| `spaces.members` | Members |
| `spaces.membersNamed` | Members: {names} |
| `spaces.membersPersonal` | Personal is yours alone: you, and the agents that work for you. To work with others, make a shared space (New space, in the sidebar) and invite them there. |
| `spaces.moreInvitations` | one: {count} more invitation / other: {count} more invitations |
| `spaces.moreOf` | {name}: more |
| `spaces.name` | Name |
| `spaces.nameArchived` | {name} (archived) |
| `spaces.nameIt` | Name it |
| `spaces.nameNewSpace` | Name the new space |
| `spaces.nameSettingPersonal` | Your Personal space is always called Personal. |
| `spaces.nameSettingShared` | What everyone sees this space as: in the sidebar, and on its chats. |
| `spaces.nameSpace` | Name the space |
| `spaces.newChat` | New chat |
| `spaces.newChatHere` | New chat here |
| `spaces.newName` | Its new name |
| `spaces.newSpace` | New space |
| `spaces.newSpaceMore` | New space… |
| `spaces.newSpaceNamed` | New space “{name}” |
| `spaces.newSpaceNote` | A shared space, to work in with others: you'll manage it, and invite them. |
| `spaces.noAgents` | No agent works here yet: chats here have no one to answer them. |
| `spaces.nothingHere` | Nothing here yet |
| `spaces.nothingHereAbout` | This app adds nothing to a space's page. |
| `spaces.nothingSent` | Nothing was sent: it named someone who doesn't answer here. |
| `spaces.notInSpace` | You're not in this space |
| `spaces.notInSpaceAbout` | It's for its members. Someone who manages it can invite you; your spaces are in the sidebar. |
| `spaces.notNow` | Not now |
| `spaces.notWorkingTitle` | one: {who} doesn't work in {where} / other: {who} don't work in {where} |
| `spaces.notYourSpace` | Not your space |
| `spaces.ok` | OK |
| `spaces.onlyOwner` | The org's only owner: make someone else an owner first |
| `spaces.onlyReadsTitle` | one: {who} only reads {where} / other: {who} only read {where} |
| `spaces.openPage` | Open {name}'s page |
| `spaces.orgInvited` | one: Invited {emails} to {org}. They'll join once they accept, signed in with that email. / other: Invited {emails} to {org}. Each joins once they accept, signed in with that email. |
| `spaces.orgNameLabel` | The org's name |
| `spaces.orgNameOthers` | Its owners change its name. |
| `spaces.orgNameOwner` | What everyone in it sees it as: in the switcher, and when they're invited. |
| `spaces.orgNamePersonal` | Your personal org shows as Personal, to you. |
| `spaces.orgPersonalAlone` | A personal org is yours alone. To work with others, make a team org (New organization, in the switcher) and invite them there. |
| `spaces.orgRoleLine` | {role} {lets}. |
| `spaces.orgSaved` | Saved. Everyone in it sees the new name. |
| `spaces.panelLabel` | {name}, beside this chat |
| `spaces.panelMissing` | This chat's space isn't one of yours. |
| `spaces.partsOf` | {title}: its parts |
| `spaces.people` | People |
| `spaces.peopleCount` | one: {count} person / other: {count} people |
| `spaces.person` | Person |
| `spaces.personal` | Personal |
| `spaces.personalAbout` | Yours alone, with your agents. To work with others, make a shared space. |
| `spaces.personalAlone` | Personal is yours alone. To work with others, make a shared space and invite them there. |
| `spaces.personalHint` | Personal: just you and your agents |
| `spaces.removedHanded` | one: {who} is out of {org}. A space only they managed went on: {spaces}. / other: {who} is out of {org}. {count} spaces only they managed went on: {spaces}. |
| `spaces.removedPlain` | {who} is out of {org}. |
| `spaces.removeFromOrg` | Remove from the org… |
| `spaces.removeFromSpace` | Remove from this space |
| `spaces.removeMeansOut` | They're signed out of {org} at once, wherever they are, and leave every space in it. |
| `spaces.removeMeansPersonal` | Their Personal space stays, as it is: the org's owners and admins still reach it. |
| `spaces.removeNamed` | Remove {name} |
| `spaces.removeTitle` | Remove {name} from {org}? |
| `spaces.rename` | Rename |
| `spaces.renameNamed` | Rename {name}… |
| `spaces.renameNote` | Everyone in it sees the new name, in the sidebar and on its chats. |
| `spaces.renameSpace` | Rename the space |
| `spaces.renameTitle` | Rename {name} |
| `spaces.renameTo` | Rename to “{name}” |
| `spaces.restore` | Restore |
| `spaces.restoreNamed` | Restore {name} |
| `spaces.roleEditor` | Editor |
| `spaces.roleEditorLets` | Reads, chats and adds things here |
| `spaces.roleManager` | Manager |
| `spaces.roleManagerLets` | Also invites people, and renames the space |
| `spaces.roleOf` | {name}'s role |
| `spaces.roles` | Roles |
| `spaces.roleViewer` | Viewer |
| `spaces.roleViewerLets` | Reads what's here |
| `spaces.save` | Save |
| `spaces.saved` | Saved. |
| `spaces.seesAsAdmin` | As an admin, you reach everything in {org}: every space, Personal ones included, with their conversations, agents, computers and memories. It's there so you can help, and hand work over when someone leaves. People's Personal spaces are still theirs. |
| `spaces.seesAsOwner` | As an owner, you reach everything in {org}: every space, Personal ones included, with their conversations, agents, computers and memories. It's there so you can help, and hand work over when someone leaves. People's Personal spaces are still theirs. |
| `spaces.seesOwners` | What owners and admins can see |
| `spaces.seesTheirs` | {org}'s owners and admins reach everything in it: every space, Personal ones included, with their conversations, agents, computers and memories. It's there so they can help, and hand work over when someone leaves. Platform staff can come in too; what they do is on {org}'s record. |
| `spaces.seesYou` | What you can see |
| `spaces.settings` | Settings |
| `spaces.shared` | Shared |
| `spaces.sharedSpace` | Shared space |
| `spaces.showIn` | Show what's in {name} |
| `spaces.showWhat` | Show {name}'s {what} |
| `spaces.space` | Space |
| `spaces.spaceMembersIn` | A space whose members are in this one |
| `spaces.spaceNameLabel` | The space's name |
| `spaces.spacesDrawing` | Spaces drawing on it |
| `spaces.spacesGroup` | Spaces |
| `spaces.spacesUnder` | {title}: spaces |
| `spaces.staff` | Staff |
| `spaces.staffRole` | Platform staff: you reach all of it, and what you do here is on its record, as yours. |
| `spaces.stay` | Stay |
| `spaces.tabIn` | {name} · {tab} |
| `spaces.tabsOf` | {name}'s tabs |
| `spaces.takeBack` | Take back |
| `spaces.takeBackTo` | Take back the invitation to {email} |
| `spaces.takeOut` | Take {name} out |
| `spaces.theirEmail` | Their email |
| `spaces.theirPersonal` | {name}'s Personal |
| `spaces.theirRole` | Their role |
| `spaces.thisSpace` | This space |
| `spaces.turnDown` | Turn down |
| `spaces.view` | View {name} |
| `spaces.waitingAdd` | one: Your message is waiting: add it to {where}, as an editor, and it goes as it is. / other: Your message is waiting: add them to {where}, as editors, and it goes as it is. |
| `spaces.waitingReads` | one: Your message is waiting: as an editor, it answers here too, and it goes as it is. / other: Your message is waiting: as editors, they answer here too, and it goes as it is. |
| `spaces.waitingToJoin` | Waiting to join |
| `spaces.whoToAdd` | Who to add |
| `spaces.workBoth` | {people} and {agents} work here. |
| `spaces.workPeopleOnly` | one: {count} person works here; no agent does yet. / other: {count} people work here; no agent does yet. |
| `spaces.you` | You |
| `spaces.youNamed` | You ({name}) |
| `spaces.youreHere` | You're here |
| `spaces.yourRole` | Your role |

## toolkit

| Key | English |
|---|---|
| `toolkit.addRow` | Add a row |
| `toolkit.addRowAfter` | Add a row after row {row} |
| `toolkit.allTime` | All time |
| `toolkit.apply` | Apply |
| `toolkit.audio` | Audio |
| `toolkit.audioFailed` | Couldn't load the {label}. Try again |
| `toolkit.audioLabel` | {label}, {length} |
| `toolkit.audioLengthUnknown` | unknown |
| `toolkit.audioLoading` | Loading |
| `toolkit.audioPause` | Pause |
| `toolkit.audioPlay` | Play |
| `toolkit.audioPosition` | {label}: position |
| `toolkit.audioProgress` | {at} of {length} |
| `toolkit.cancel` | Cancel |
| `toolkit.changeFile` | Change |
| `toolkit.chooseDate` | Choose a date |
| `toolkit.chooseDates` | Choose dates |
| `toolkit.chooseDateTime` | Choose a date and time |
| `toolkit.chooseFile` | Choose a file |
| `toolkit.chooseFiles` | Choose files |
| `toolkit.chosen` | one: {count} chosen / other: {count} chosen |
| `toolkit.close` | Close |
| `toolkit.columns` | Columns |
| `toolkit.confirm` | Confirm |
| `toolkit.copied` | Copied |
| `toolkit.copy` | Copy |
| `toolkit.copyCode` | Copy code |
| `toolkit.copyId` | Copy ID |
| `toolkit.customRange` | Custom range |
| `toolkit.delete` | Delete |
| `toolkit.done` | Done |
| `toolkit.dropFiles` | Drop files here |
| `toolkit.export` | Export |
| `toolkit.files` | one: {count} file / other: {count} files |
| `toolkit.hideDetails` | Hide details |
| `toolkit.hoursAgo` | one: {count} hour ago / other: {count} hours ago |
| `toolkit.hoursShort` | {count}h |
| `toolkit.inHours` | one: in {count} hour / other: in {count} hours |
| `toolkit.inHoursShort` | in {count}h |
| `toolkit.inMinutes` | one: in {count} minute / other: in {count} minutes |
| `toolkit.inMinutesShort` | in {count}m |
| `toolkit.items` | one: {count} item / other: {count} items |
| `toolkit.justNow` | just now |
| `toolkit.last30Days` | Last 30 days |
| `toolkit.last7Days` | Last 7 days |
| `toolkit.lastFiscalYear` | Last fiscal year |
| `toolkit.lastMonth` | Last month |
| `toolkit.lastYear` | Last year |
| `toolkit.loadingRows` | Loading… |
| `toolkit.mathLoading` | Loading math |
| `toolkit.mathPending` | Still being written |
| `toolkit.minutesAgo` | one: {count} minute ago / other: {count} minutes ago |
| `toolkit.minutesShort` | {count}m |
| `toolkit.navigation` | Navigation |
| `toolkit.nextMonth` | Next month |
| `toolkit.nextPage` | Next page |
| `toolkit.no` | No |
| `toolkit.noMatches` | Nothing matches “{text}” |
| `toolkit.noneChosen` | None chosen |
| `toolkit.noRows` | Nothing to show |
| `toolkit.notDone` | It wasn't done. Try again. |
| `toolkit.notifications` | Notifications |
| `toolkit.notSaved` | It wasn't saved. Try again. |
| `toolkit.now` | now |
| `toolkit.page` | Page {page} |
| `toolkit.pages` | Pages |
| `toolkit.previousMonth` | Previous month |
| `toolkit.previousPage` | Previous page |
| `toolkit.print` | Print |
| `toolkit.rangeFrom` | From |
| `toolkit.rangeTo` | To |
| `toolkit.removeFile` | Remove |
| `toolkit.removeRow` | Remove row {row} |
| `toolkit.removeTag` | Remove {tag} |
| `toolkit.required` | required |
| `toolkit.row` | Row {row} |
| `toolkit.rowsPerPage` | {size} rows per page |
| `toolkit.sameMonthLastYear` | This month last year |
| `toolkit.sameMonthToDateLastYear` | This month to date, last year |
| `toolkit.save` | Save |
| `toolkit.search` | Search |
| `toolkit.selectAll` | Select all rows |
| `toolkit.selectRow` | Select this row |
| `toolkit.showDetails` | Show details |
| `toolkit.showEarlierLines` | one: Show {count} earlier line / other: Show {count} earlier lines |
| `toolkit.showingRows` | Showing {from} to {to} of {total} rows |
| `toolkit.showLess` | Show less |
| `toolkit.showMore` | Show more |
| `toolkit.showMoreLines` | one: Show {count} more line / other: Show {count} more lines |
| `toolkit.table` | Table |
| `toolkit.terminal` | Terminal |
| `toolkit.terminalFailed` | Check your connection, then try again. |
| `toolkit.terminalFailedTitle` | The terminal didn't load |
| `toolkit.terminalOpening` | Opening the terminal… |
| `toolkit.thisFiscalYear` | This fiscal year |
| `toolkit.thisMonth` | This month |
| `toolkit.thisYear` | This year |
| `toolkit.time` | Time of day |
| `toolkit.today` | Today |
| `toolkit.todayLastYear` | Today last year |
| `toolkit.toDo` | To do |
| `toolkit.tomorrow` | Tomorrow |
| `toolkit.tryAgain` | Try again |
| `toolkit.when` | When |
| `toolkit.yes` | Yes |
| `toolkit.yesterday` | Yesterday |

## usage

| Key | English |
|---|---|
| `usage.aComputer` | a computer |
| `usage.aConversation` | a conversation |
| `usage.activity` | Activity |
| `usage.activityEveryone` | Everyone's, newest first |
| `usage.activityEveryoneFiltered` | Everyone's, newest first, as filtered |
| `usage.activityYours` | Yours, newest first |
| `usage.activityYoursFiltered` | Yours, newest first, as filtered |
| `usage.agent` | Agent |
| `usage.anAgent` | An agent |
| `usage.anApp` | an app |
| `usage.appTitle` | App {app} |
| `usage.beforeSpaces` | used before spaces were recorded |
| `usage.billing` | Billing |
| `usage.budgetLeft` | {amount} left |
| `usage.budgetLeftEnough` | {amount} left, enough for the month at this pace |
| `usage.budgetLeftLasts` | {amount} left, {lasts} at this pace |
| `usage.budgetUsedUp` | the budget is used up |
| `usage.buildMinutes` | one: {minutes} build minute / other: {minutes} build minutes |
| `usage.byAgent` | agent |
| `usage.byKind` | kind |
| `usage.byModel` | model |
| `usage.byPerson` | person |
| `usage.bySpace` | space |
| `usage.cachingCost` | caching cost {amount} more than it saved |
| `usage.cachingSaved` | caching saved {amount} |
| `usage.calls` | one: {calls} call / other: {calls} calls |
| `usage.chartKeys` | {label}: arrow keys move between days |
| `usage.chartLabel` | Spend per day in {month}, by {by} |
| `usage.chipWhat` | {what}: |
| `usage.computerTitle` | Computer {computer} {size} |
| `usage.conversationUpkeep` | Conversation upkeep |
| `usage.costColumn` | Cost |
| `usage.costOf` | Cost {amount} |
| `usage.creditsLeft` | {amount} of credits left |
| `usage.creditsLeftLasts` | {amount} of credits left, {lasts} at this pace |
| `usage.day` | Day |
| `usage.dayAnnounced` | {day}: {spend} |
| `usage.diskOf` | Disk of {computer} |
| `usage.emptyEveryone` | As agents answer, computers run and apps serve in this org, what each was charged shows here, by kind, space, person, agent and model. |
| `usage.emptyOwn` | As agents answer and computers run for you, what each was charged shows here. |
| `usage.everyone` | Everyone |
| `usage.fromCache` | {percent} from cache |
| `usage.fromCacheColumn` | From cache |
| `usage.fromInputCache` | {percent} of input from cache |
| `usage.gbHours` | {amount} GB-hours |
| `usage.hideModelCalls` | Hide its model calls |
| `usage.hideNumbers` | Hide the numbers |
| `usage.hours` | {hours}h |
| `usage.hoursMinutes` | {hours}h {minutes}m |
| `usage.inColumn` | In |
| `usage.justYou` | Just you |
| `usage.keptTo` | Kept to |
| `usage.kind` | Kind |
| `usage.kindAgents` | Agents |
| `usage.kindApps` | Apps |
| `usage.kindComputers` | Computers |
| `usage.lastsDay` | about a day |
| `usage.lastsDays` | about {count} days |
| `usage.lastsLessThanDay` | less than a day |
| `usage.lastsMonths` | about {count} months |
| `usage.lastsWeeks` | about {count} weeks |
| `usage.lastsYear` | more than a year |
| `usage.marginOf` | {percent} margin |
| `usage.meterLabel` | Spent this month, against the budget |
| `usage.meterNow` | How far into the month we are |
| `usage.meterTitle` | {meter}: {model} |
| `usage.meterValue` | {spent} of {limit} |
| `usage.minutes` | {count} min |
| `usage.model` | Model |
| `usage.modelCalls` | Model calls |
| `usage.month` | Month |
| `usage.noKnownCost` | No known cost |
| `usage.nothingByPoint` | Nothing by this point last month |
| `usage.nothingIn` | Nothing in {against} |
| `usage.nothingMatches` | Nothing here matches what's chosen. |
| `usage.nothingUsedIn` | Nothing used in {month} |
| `usage.nothingUsedThisMonth` | Nothing used this month yet |
| `usage.notTiedToAnyone` | Not tied to anyone |
| `usage.onDay` | on {day} |
| `usage.otherModelUse` | Other model use |
| `usage.outColumn` | Out |
| `usage.outOfCredits` | out of credits |
| `usage.overCost` | {amount} over cost |
| `usage.ownUsage` | Your own usage. The org's owners and admins see everyone's. |
| `usage.person` | Person |
| `usage.personalSpaceOf` | {name}'s Personal space |
| `usage.plan` | Plan |
| `usage.planTitle` | Ran on a connected plan: no credits used |
| `usage.pointLastMonth` | this point last month |
| `usage.purposeDraft` | Drafting agents |
| `usage.purposeHistory` | Summaries |
| `usage.purposeMemory` | Memory notes |
| `usage.purposeTranscription` | Voice transcribed |
| `usage.quoted` | “{name}” |
| `usage.readAgain` | Read it again |
| `usage.readError` | We couldn't read this org's usage just now. {error} |
| `usage.requests` | {requests} requests |
| `usage.rowCost` | Cost {amount} |
| `usage.rowCostMargin` | Cost {amount} · {percent} margin |
| `usage.rowsLabel` | By {by}: choose one to see only it |
| `usage.saved` | {amount} saved |
| `usage.savedNegative` | {amount} more than without it |
| `usage.savedNothing` | Nothing saved yet |
| `usage.seconds` | {count} s |
| `usage.seeOnly` | See only {name} |
| `usage.seriesAnnounced` | {name} {amount} |
| `usage.shareOfAll` | {percent} of all spend |
| `usage.shareOfBudget` | {percent} of the {limit} budget |
| `usage.showAll` | Show all {count} |
| `usage.showAllAgain` | Show all again |
| `usage.showAllNotOnly` | Show all, not only {name} |
| `usage.showEverything` | Show everything |
| `usage.showFewer` | Show fewer |
| `usage.showingOnly` | Showing only |
| `usage.showModelCalls` | one: Show its {count} model call / other: Show its {count} model calls |
| `usage.showNumbers` | Show the numbers |
| `usage.showOlder` | Show older |
| `usage.snapshotOf` | Snapshot of {computer} |
| `usage.space` | Space |
| `usage.spaceNotReached` | A space you don't reach |
| `usage.spaceNotRecorded` | Space not recorded |
| `usage.spend` | Spend |
| `usage.spendBy` | Spend by |
| `usage.spentByYouIn` | spent by you in {month} |
| `usage.spentByYouThisMonth` | spent by you this month |
| `usage.spentIn` | spent in {month} |
| `usage.spentThisMonth` | spent this month |
| `usage.staffCostMargin` | Cost and margin: staff only |
| `usage.staffOnly` | Staff only |
| `usage.stillToCome` | Still to come |
| `usage.theRest` | The rest |
| `usage.thisMonth` | This month |
| `usage.time` | Time |
| `usage.tokens` | {tokens} tokens |
| `usage.tryAgain` | Try again |
| `usage.turnTitle` | {agent} in {where} |
| `usage.underCost` | {amount} under cost |
| `usage.unpriced` | one: We don't know what {total} use cost: their models aren't in the price catalog, and the app sets no rate for them, so the spend may leave them out. / other: We don't know what {total} uses cost: their models aren't in the price catalog, and the app sets no rate for them, so the spend may leave them out. |
| `usage.upkeepDetail` | summaries, memory notes, voice |
| `usage.upkeepOf` | Upkeep of {where} |
| `usage.uses` | one: {count} use / other: {count} uses |
| `usage.versus` | vs. {against} |
| `usage.whoseUsage` | Whose usage |
| `usage.woke` | woke {from}, last {last} |
| `usage.you` | You |
| `usage.yourKey` | Your key |
| `usage.yourKeyTitle` | Ran on your own key: no credits used |
| `usage.yourPersonalSpace` | Your Personal space |
