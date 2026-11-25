# STAGING: rc.65, archiving chats (not published)

What this stream adds to `CHANGELOG.md` and `AGENTS.md`, for whoever assembles the release. Neither
file is edited here.

## (a) The CHANGELOG entry

Under rc.65's **New:**

- **Archiving a chat** (`chat.archive`, `{ thread, archived, latest? }`): "Archive" in its header's
  menu, a Chats tab row's menu and the command palette, and `/archive` in the terminal. A person who
  may write where the chat is puts it away, for everyone who sees it, as a title: lists leave it out
  (`thread.recent`, so the sidebar, the Chats tab, the palette until you search, `/threads` and
  agents' `list_conversations`), with its staff notes and subthreads. Nothing in it changes, and it
  still opens by its link. Archived chats are listed apart, under a folded "Archived" at the end of
  the Chats tab (read only once it's opened or the tab is searched), by `thread.recent`'s
  `archived: true`, and by `/threads archived`; the palette finds them while searching. Restore
  brings one back (`archived: false`, `/restore`), and so does any new message in it, its notes or a
  subthread, in that message's own commit: a customer writing on WhatsApp reopens their chat. Front
  ends pass `latest`, the newest message they drew (`null` for none), and archiving is refused
  (`conflict`) when anything in the conversation is newer: the chat, its notes, its subthreads at
  every level.

Under rc.65's **Fixed:**

- The REST guide's list of Actions a key can't call names `chat.rename` (since rc.63) and
  `chat.archive`.

## (b) AGENTS.md

In "Find it: what an app needs, and where it's documented", a new group after **Actions, access and
mail**:

```markdown
**Chats**

- Archive a chat, for everyone who sees it → `chat.archive { thread, archived: true }` →
  [Archiving a chat](docs/guides/chats.md#archiving-a-chat).
- Restore an archived chat → `chat.archive { thread, archived: false }`, or a new message →
  [Restoring a chat](docs/guides/chats.md#restoring-a-chat).
- List archived chats → `thread.recent { archived: true }` →
  [Listing archived chats](docs/guides/chats.md#listing-archived-chats).
```

## (c) "Find it" lines

- Archive a chat, for everyone who sees it → `chat.archive { thread, archived: true }` →
  docs/guides/chats.md#archiving-a-chat
- Restore an archived chat → `chat.archive { thread, archived: false }`, or a new message →
  docs/guides/chats.md#restoring-a-chat
- List archived chats → `thread.recent { archived: true }` →
  docs/guides/chats.md#listing-archived-chats
