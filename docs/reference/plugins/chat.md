---
title: "chat"
description: "Chat: threads where people and agents talk."
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# chat

Chat: threads where people and agents talk.

```ts
import { chat } from "copilotz/plugins/agents";
```

## What it keeps

It keeps 7 collections, 4 of them on the record.

| Collection | Kept as                             | Fields                                                                                                                                                                                                                                      |
| ---------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`     | documents                           | `name`, `type`, `size`, `data`, `draft`, `voice`, `transcript`, `thread`, `in`, `private`, `at`                                                                                                                                             |
| `intent`   | documents                           | `thread`, `agent`, `step`, `text`, `state`, `told`, `calls`, `outputs`, `asks`, `again`, `at`                                                                                                                                               |
| `live`     | in memory, gone on restart          | `thread`, `agent`, `turn`, `text`, `calls`, `retry`, `open`, `in`, `at`                                                                                                                                                                     |
| `message`  | documents                           | `thread`, `from`, `to`, `text`, `toolCalls`, `private`, `replyTo`, `expectReply`, `subthread`, `hops`, `turn`, `failed`, `in`, `files`, `sources`, `stopped`, `tap`, `via`, `back`, `state`, `told`, `knew`, `at`; private: `state`, `told` |
| `shown`    | records, appended and never changed | `thread`, `in`, `key`, `after`, `medium`, `fallback`, `note`, `at`                                                                                                                                                                          |
| `thread`   | documents                           | `title`, `renamable`, `agents`, `parent`, `fork`, `in`, `messages`, `opened`, `latest`, `at`                                                                                                                                                |
| `wait`     | documents                           | `agent`, `thread`, `trigger`, `hops`, `waitingFor`, `received`, `step`, `at`                                                                                                                                                                |

The access rules cover `file`, `live`, `message`, `shown` and `thread`: each document is in a space,
and only those who reach the space reach it.

Its named queries read for callers, as the rules let them:

| Query                  | Who outside runs it                                      |
| ---------------------- | -------------------------------------------------------- |
| `file.about`           | people, contacts and keys                                |
| `message.conversation` | people and keys                                          |
| `message.history`      | people and keys                                          |
| `message.questions`    | people or keys, depending on input                       |
| `message.visible`      | the app's code                                           |
| `thread.agents`        | people and keys                                          |
| `thread.prompt`        | people and keys; agents for a person, depending on input |
| `thread.recent`        | people and keys                                          |

## What it lets callers do

Of its 12 Actions, people may call 6; contacts may call 2; agents and someone signed out may call
none.

| Action        | Person | Agent | Contact | Anyone | Key | What it does                                                              |
| ------------- | ------ | ----- | ------- | ------ | --- | ------------------------------------------------------------------------- |
| `chat.attach` | yes    | no    | yes     | no     | yes | Uploads a file to send: a draft that a message of yours sends, by its id. |
| `chat.fork`   | yes    | no    | no      | no     | yes |                                                                           |
| `chat.move`   | yes    | no    | no      | no     | yes | Moves a conversation, with everything in it, to another space.            |
| `chat.open`   | yes    | no    | no      | no     | yes | Opens an empty chat in a space.                                           |
| `chat.send`   | yes    | no    | yes     | no     | yes |                                                                           |
| `chat.stop`   | yes    | no    | no      | no     | yes | Stops agents' turns in a conversation (and its subthreads).               |

A key calls what its person may, when its scope names the Action.

Only the app's own code calls `chat.erase`, `chat.import`, `chat.prune`, `chat.quiet`, `chat.say`
and `chat.shown`: its plugins, its schedules and the system.

It answers 1 route over HTTP:

| Method    | Path       |
| --------- | ---------- |
| GET, HEAD | `/files/*` |

It also adds rules every read and write keeps to (`guard`).

## Where it shows

Its Views show to the model and elsewhere.

- **To the model:** `llm.message`, `llm.thread`.
- **Elsewhere:** `context`, `history`, `participants`.
- **Front ends:** [`chat-terminal`](chat-terminal.md) and [`chat-web`](chat-web.md).
- **What it adds to resources:** `usageNames` (`thread`).

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

It ships with `copilotz@1.0.0-rc.31`.

## What it does on its own

Some of its work starts without a caller: an event, or the time.

- `chat.failed` runs on `processor.failed`.
- `chat.turn` runs on `turn.requested` or `wait.updated`.
- `chat.prune` calls `chat.prune`, every 1h. Drops files uploaded to send that no message sent
  within a day.
- It emits `turn.requested`. An agent is to take a turn in a thread, because of a message.

## Listing

It breaks 1 listing rule as it is:

- Route "/files/*" isn't under /chat.

And before adding it, know this:

- Action "chat.fork" has no description.
- Action "chat.send" has no description.
