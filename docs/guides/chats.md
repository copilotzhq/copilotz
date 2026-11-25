---
title: "Chats: their lists and archive"
description: "The chats a person sees, listed with thread.recent; archiving one for everyone who sees it, and restoring it; what brings it back; and where archived chats are still found, by people and by agents."
section: Guides
order: 11
---

# Chats: their lists and archive

A chat is a `thread` document of the chat plugin, in a space (`in`). People find chats in lists: the
sidebar, a space's Chats tab, the command palette, the terminal's `/threads`. Agents find them with
`list_conversations`. Every one of those lists is one named query, `thread.recent`.

When a chat's work is done, a person archives it. It's put away, for everyone who sees it, until
someone restores it or a new message brings it back.

## Listing chats

`thread.recent` answers the latest chats the asker reads, newest first by their last message: in one
space with `in`, else in every space they reach. Each comes with how many messages it has
(`messages`) and what its first and last ones say (`first`, `last`), as the asker may read them.

```ts
const chats = await runtime.query<Thread[]>("thread.recent", { in: space, limit: 50 }, {
  actor: ana,
});
```

In a View, the same query keeps the list live:

```tsx
const chats = ctx.db.collection("thread").query<Thread[]>("recent", { in: space }).value;
```

It answers at most `limit` chats (20 unless asked). A chat's subthreads, which agents open beside
it, aren't listed: they show under the message that opened them. A chat's staff notes (a contact's
chat's, see `chat.notes`) are listed beside it.

## Archiving a chat

`chat.archive` with `archived: true` puts a chat away:

```ts
await runtime.call("chat.archive", { thread: order, archived: true }, { actor: ana });
// { thread: order, archived: true }
```

- **Who:** a person, in person (`inPerson`): not an agent working for one, a key, a routine or a
  contact. They must be able to write where the chat is, as for `chat.rename`: an editor of its
  space, its Personal space's owner. A viewer is refused (`forbidden`), and that's checked first:
  before `conflict`, and before finding there's nothing to change.
- **For everyone:** it's one field on the chat (`archived`, the time it was put away), so it's
  archived for everyone who sees it, as its title is. A chat in a Personal space is its owner's
  alone anyway.
- **Its notes and subthreads go with it.** Asked about a chat's staff notes or one of its
  subthreads, `chat.archive` archives the chat, and answers with the chat's id. Lists leave the
  notes out with their chat.
- **Nothing in it changes:** its messages, files, title, space and members stay as they are, and
  anyone who reads it can still open it by its link or id. A turn running in it goes on.
- **Nothing new is put away unseen.** A front end passes `latest`, the newest message it drew of the
  conversation, or `null` when it drew none. If anything in the conversation is newer (in the chat,
  its staff notes or any of its subthreads, at any level), archiving is refused (`conflict`) and
  nothing changes. A message as old as that one counts as seen. An agent's private steps don't
  count:

  ```ts
  // What the page drew: message.conversation's answer, oldest first.
  const latest = shown.findLast((m) => !m.private)?._id ?? null;
  await runtime.call("chat.archive", { thread: notes, archived: true, latest }, { actor: ana });
  ```

  Left out, nothing is checked: code that archives on its own account, not for what someone saw.

Archiving an archived chat, or restoring one that isn't, changes nothing.

On the web, a chat's header menu, a row's menu on the Chats tab and the command palette's "Archive
this chat" archive it. Each passes what it drew: a page, its transcript (the chat's page, its notes'
too while their lane is open); a row, the message it shows. Refused, a toast says something new
arrived, with a way to the chat. In the terminal, `/archive` puts the open conversation away, or one
`/threads` listed (`/archive 2`), checking what the screen or the list showed of it; one named by id
is put away as it is.

## Restoring a chat

`archived: false` brings it back, listed with the others again:

```ts
await runtime.call("chat.archive", { thread: order, archived: false }, { actor: ana });
```

So does any new message in it, its staff notes or one of its subthreads, in the commit that writes
the message: a person's, a contact's (a customer writing on WhatsApp reopens their chat), an agent's
answer, question or message (one opening a subthread too), an answer handed back from another space,
`chat.say`, a routine's run. A message never lands in a chat nobody sees. An agent's private steps
(its tools' calls) don't bring a chat back.

What's archived after a message stays archived: the order the two commit in decides.

Two ways to add to a chat aren't new messages, by design:

- **Importing** (`chat.import`) writes a conversation's past: an archived chat imported into stays
  archived.
- **Forking** (`chat.fork`) makes a chat of its own: forking an archived chat starts a new one,
  listed, and the archived one stays put away. Messages in the fork bring back the fork alone.

On the web, an archived chat's page says so, with Restore, and so does its notes' page; so do its
row's menu and the palette. In the terminal, `/restore`.

## Listing archived chats

`thread.recent` leaves archived chats out, with their staff notes. Telling those notes apart reads
nothing more when their chat is on the same page, and one read when it isn't. `archived: true`
answers the archived chats instead:

```ts
const put = await runtime.query<Thread[]>("thread.recent", { in: space, archived: true }, {
  actor: ana,
});
```

On the web, a space's Chats tab ends with a folded "Archived": unfolded, or while the tab is
searched, it lists them (the `chats.archived` View), and nothing of them is read before. The command
palette finds archived chats while searching, said so ("Archived, in Launch"). In the terminal,
`/threads archived` lists them, and `/open` opens one by number or id.

## Agents and archived chats

An agent's `list_conversations` leaves archived chats out: it reads `thread.recent`. It still reads
one by its id (`read_conversation`), and a message it sends there (`send_message`'s `thread`) brings
the chat back.

## Known limits

Kept simple on purpose:

- **What a page doesn't draw keeps it from archiving there.** The chat's page draws its own messages
  and its subthreads' one level down, and its notes only while their lane is open. A newer message
  further down, or in closed notes, refuses archiving from that page until something newer is drawn
  there, or it's archived from where that message shows (the notes, the subthread's page).
- **An archived chat's notes aren't listed with it.** Open the chat: its notes are beside it (in the
  terminal, `/open` it, then `/notes`).
- **A subthread opened as a page doesn't say its chat is archived.** Archiving from there archives
  the chat, and restoring it is on the chat's page.
- **Subthreads are known by their ids.** A thread is a subthread of the one it hangs from when its
  id is `<message>:sub`, as `send_message` makes them; one an app makes otherwise is a chat of its
  own, archived and listed as one.
