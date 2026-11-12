---
title: "chat"
description: "Chat: threads where people and agents talk."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# chat

Chat: threads where people and agents talk.

```ts
import { chat } from "copilotz/plugins/agents";
```

## What it keeps

It keeps 7 collections, 4 of them on the record.

| Collection | Kept as                             | Fields                                                                                                                                                                                                                                   |
| ---------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`     | documents                           | `name`, `type`, `size`, `data`, `draft`, `voice`, `transcript`, `thread`, `in`, `private`, `at`                                                                                                                                          |
| `intent`   | documents                           | `thread`, `agent`, `step`, `text`, `state`, `told`, `calls`, `outputs`, `asks`, `again`, `at`                                                                                                                                            |
| `live`     | in memory, gone on restart          | `thread`, `agent`, `turn`, `text`, `calls`, `retry`, `open`, `in`, `at`                                                                                                                                                                  |
| `message`  | documents                           | `thread`, `from`, `to`, `text`, `toolCalls`, `private`, `replyTo`, `expectReply`, `subthread`, `hops`, `turn`, `failed`, `in`, `files`, `drew`, `stopped`, `tap`, `via`, `back`, `state`, `told`, `knew`, `at`; private: `state`, `told` |
| `shown`    | records, appended and never changed | `thread`, `in`, `key`, `after`, `medium`, `fallback`, `note`, `at`                                                                                                                                                                       |
| `thread`   | documents                           | `title`, `renamable`, `agents`, `parent`, `fork`, `in`, `about`, `messages`, `opened`, `latest`, `at`                                                                                                                                    |
| `wait`     | documents                           | `agent`, `thread`, `trigger`, `hops`, `waitingFor`, `received`, `step`, `at`                                                                                                                                                             |

The access rules cover `file`, `live`, `message`, `shown` and `thread`: each document is in a space,
and only those who reach the space reach it.

Its named queries read for callers, as the rules let them:

| Query                  | Who outside runs it                                                |
| ---------------------- | ------------------------------------------------------------------ |
| `file.about`           | people, agents for a person, contacts, keys and routines           |
| `message.conversation` | people, agents for a person, keys and routines                     |
| `message.history`      | people, agents for a person, keys and routines                     |
| `message.questions`    | people, keys or routines, depending on input                       |
| `message.visible`      | the app's code                                                     |
| `thread.agents`        | people, agents for a person, keys and routines                     |
| `thread.moving`        | people, agents for a person, keys and routines                     |
| `thread.prompt`        | people, keys and routines; agents for a person, depending on input |
| `thread.recent`        | people, agents for a person, keys and routines                     |

## What it lets callers do

Of its 14 Actions, people may call 7; agents may call 4; contacts may call 2; someone signed out may
call none.

| Action        | Person | Agent | Contact | Anyone | Key | Routine | Maintenance | What it does                                                                           |
| ------------- | ------ | ----- | ------- | ------ | --- | ------- | ----------- | -------------------------------------------------------------------------------------- |
| `chat.attach` | yes    | no    | yes     | no     | yes | yes     | no          | Uploads a file to send: a draft that a message of yours sends, by its id.              |
| `chat.fork`   | yes    | yes   | no      | no     | yes | yes     | no          |                                                                                        |
| `chat.move`   | yes    | no    | no      | no     | no  | no      | no          | Moves a conversation, with everything in it, to another space.                         |
| `chat.notes`  | yes    | yes   | no      | no     | yes | yes     | no          | The notes beside a chat shared outside its space, made the first time.                 |
| `chat.open`   | yes    | yes   | no      | no     | yes | yes     | no          | Opens an empty chat in a space.                                                        |
| `chat.send`   | yes    | no    | yes     | no     | yes | yes     | no          |                                                                                        |
| `chat.stop`   | yes    | yes   | no      | no     | yes | yes     | no          | Stops agents' turns in a conversation (and its subthreads).                            |
| `chat.unmark` | no     | no    | no      | no     | no  | no      | yes         | Takes the old marks off messages: each goes where only those who could read it see it. |

An agent works for a person, and calls what both may. A key calls only what its scope names. A
routine is work done for a person, which they set going.

Only the app's own code calls `chat.erase`, `chat.import`, `chat.prune`, `chat.quiet`, `chat.say`
and `chat.shown`: its plugins, its schedules and the system.

Agents act through its 2 tools, as whoever they work for:

| Tool                 | What it does                                                                                                                                                                                                        | Calls |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `list_conversations` | List the other conversations in this space, latest first: each one's id, how it opened, where it is now, and how many messages it has.                                                                              |       |
| `read_conversation`  | Read what was said in another conversation (by its id, from list_conversations): its messages, oldest first, the latest `limit` of them, or those before `before` (a time from a previous read) to go further back. |       |

It answers 1 route over HTTP:

| Method    | Path       |
| --------- | ---------- |
| GET, HEAD | `/files/*` |

It also adds rules every read and write keeps to (`guard`).

## Where it shows

Its Views show to the model and elsewhere.

- **To the model:** `context:notes`, `llm.message`, `llm.thread`.
- **Elsewhere:** `context`, `history`, `participants`.
- **Agents' tools:** `list_conversations`, `read_conversation`.
- **Front ends:** [`chat-terminal`](chat-terminal.md) and [`chat-web`](chat-web.md).
- **What it adds to resources:** `context` (`notes`), `usageNames` (`thread`).

## What it needs

You set it in `resources.chat`.

| Setting            | Type       | Required | What it is                                                                                                      |
| ------------------ | ---------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `chat.maxHops`     | `number`   | no       | How many agent messages in a row, after a person's, may start another agent's turn.                             |
| `chat.maxSteps`    | `number`   | no       | How many steps (model calls) one agent turn may take before it fails, so a runaway agent stops.                 |
| `chat.transcriber` | `ModelRef` | no       | The model that transcribes audio sent with a message (default: the `transcribe` alias, from `resources.model`). |

It also reads `agentModel`, `agentSources`, `agents`, `contactSend`, `context`, `roster` and
`tools`, resource kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`models`](models.md): add it too.

It ships with `copilotz@1.0.0-rc.45`.

## What it does on its own

Some of its work starts without a caller: an event, or the time.

- `chat.failed` runs on `processor.failed`.
- `chat.turn` runs on `turn.requested` or `wait.updated`.
- `chat.prune` calls `chat.prune`, every 1h. Drops files uploaded to send that no message sent
  within a day.
- `chat.unmark` calls `chat.unmark`, once, when the runtime first starts with it. Takes the old
  marks off messages: each goes where only those who could read it see it.
- It emits `turn.requested`. An agent is to take a turn in a thread, because of a message.

## Listing

It breaks 1 listing rule as it is:

- Route "/files/*" isn't under /chat.

And before adding it, know this:

- Action "chat.fork" has no description.
- Action "chat.send" has no description.
