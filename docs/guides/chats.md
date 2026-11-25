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
  space, its Personal space's owner. A viewer is refused (`forbidden`).
- **For everyone:** it's one field on the chat (`archived`, the time it was put away), so it's
  archived for everyone who sees it, as its title is. A chat in a Personal space is its owner's
  alone anyway.
- **Its notes and subthreads go with it.** Asked about a chat's staff notes or one of its
  subthreads, `chat.archive` archives the chat, and answers with the chat's id. Lists leave the
  notes out with their chat.
- **Nothing in it changes:** its messages, files, title, space and members stay as they are, and
  anyone who reads it can still open it by its link or id. A turn running in it goes on.
- **Nothing new is put away unseen.** A front end passes the chat's latest message as it showed it
  (the thread's `latest`). If something was said since, archiving is refused (`conflict`) and
  nothing changes:

  ```ts
  await runtime.call("chat.archive", { thread: order, archived: true, latest: shown.latest }, {
    actor: ana,
  });
  ```

Archiving an archived chat, or restoring one that isn't, changes nothing.

On the web, a chat's header menu, a row's menu on the Chats tab and the command palette's "Archive
this chat" archive it. In the terminal, `/archive` puts the open conversation away, or one
`/threads` listed (`/archive 2`).

## Restoring a chat

`archived: false` brings it back, listed with the others again:

```ts
await runtime.call("chat.archive", { thread: order, archived: false }, { actor: ana });
```

So does any new message in it, its staff notes or one of its subthreads, in the commit that writes
the message: a person's, a contact's (a customer writing on WhatsApp reopens their chat), an agent's
answer or question, an answer handed back from another space, `chat.say`, a routine's run. A message
never lands in a chat nobody sees. An agent's private steps (its tools' calls) don't bring a chat
back; its answer does.

What's archived after a message stays archived: the order the two commit in decides.

On the web, an archived chat's page says so, with Restore; so do its row's menu and the palette. In
the terminal, `/restore`.

## Listing archived chats

`thread.recent` leaves archived chats out, with their staff notes. `archived: true` answers the
archived chats instead:

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
