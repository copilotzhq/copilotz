---
title: "voice"
description: "Voice: people call the app's phone number and talk to its agents, through Twilio's ConversationRelay (Twilio hears them and speaks for the agent; the app gets and sends text)."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# voice

Voice: people call the app's phone number and talk to its agents, through Twilio's ConversationRelay
(Twilio hears them and speaks for the agent; the app gets and sends text).

```ts
import { voice } from "copilotz/plugins/interfaces";
```

## What it keeps

It keeps 3 collections.

| Collection      | Kept as   | Fields                                                                                                                                                                                                        |
| --------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `voice_blocked` | documents | `line`, `in`, `thread`, `key`, `until`, `at`; private: `key`                                                                                                                                                  |
| `voice_call`    | documents | `line`, `in`, `from`, `to`, `verified`, `erased`, `state`, `ticket`, `until`, `session`, `contact`, `thread`, `cut`, `end`, `reason`, `seconds`, `twilio`, `at`, `started`, `over`; private: `from`, `ticket` |
| `voice_phone`   | documents | `line`, `phone`, `contact`, `thread`, `at`; private: `phone`                                                                                                                                                  |

The access rules cover `voice_blocked`: each document is in a space, and only those who reach the
space reach it.

## What it lets callers do

Of its 9 Actions, people may call 2; agents, contacts and someone signed out may call none.

| Action          | Person | Agent | Contact | Anyone | Key | Routine | What it does                                                                  |
| --------------- | ------ | ----- | ------- | ------ | --- | ------- | ----------------------------------------------------------------------------- |
| `voice.block`   | yes    | no    | no      | no     | no  | no      | Blocks the caller behind a phone call's chat (for so many days, or for good). |
| `voice.unblock` | yes    | no    | no      | no     | no  | no      | Lifts a block on a caller, by its id.                                         |

An agent works for a person, and calls what both may. A key calls only what its scope names. A
routine is work done for a person, which they set going.

Only the app's own code calls `voice.admit`, `voice.hangup`, `voice.heard`, `voice.over`,
`voice.prune`, `voice.ring` and `voice.start`: its plugins, its schedules and the system.

Agents act through its tool, as whoever they work for:

| Tool       | What it does                                                                    | Calls |
| ---------- | ------------------------------------------------------------------------------- | ----- |
| `end_call` | Ends the phone call once the caller has what they need and you've said goodbye. |       |

It answers 3 routes over HTTP:

| Method | Path                       |
| ------ | -------------------------- |
| POST   | `/hooks/voice/:name`       |
| POST   | `/hooks/voice/:name/over`  |
| GET    | `/hooks/voice/:name/relay` |

It also adds rules every read and write keeps to (`guard`).

## Where it shows

Its Views show to the model and elsewhere.

- **To the model:** `context:voice`.
- **Elsewhere:** `voice.message`, `voice_call`.
- **Agents' tools:** `end_call`.
- **What it adds to resources:** `context` (`voice`).

## What it needs

You set it in `resources.voice`: 4 settings are required, and 1 is a secret, kept out of your code.

| Setting                      | Type              | Required | What it is                                                                                                                                       |
| ---------------------------- | ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `voice.<name>.in`            | `string`          | yes      | The space its callers' chats live in (declared with the spaces plugin's `spaces`, or not).                                                       |
| `voice.<name>.account`       | `string`          | yes      | Twilio's account SID (`AC…`) and auth token: the token signs Twilio's requests.                                                                  |
| `voice.<name>.token`         | `string`          | yes      | Secret. Twilio's account SID (`AC…`) and auth token: the token signs Twilio's requests.                                                          |
| `voice.<name>.origin`        | `string`          | yes      | The app's public address, as Twilio reaches it (`https://calls.example.com`): the signatures cover it, and the socket's address is made from it. |
| `voice.<name>.agent`         | `string`          | no       | Who answers its callers: an agent of its space (else who answers new chats there).                                                               |
| `voice.<name>.language`      | `string`          | no       | What callers speak and hear: a BCP-47 tag (`pt-BR`; `en-US` by default).                                                                         |
| `voice.<name>.tts`           | `string`          | no       | Twilio's text-to-speech provider (`ElevenLabs`, `Google`, `Amazon`) and its voice.                                                               |
| `voice.<name>.voice`         | `string`          | no       | Twilio's text-to-speech provider (`ElevenLabs`, `Google`, `Amazon`) and its voice.                                                               |
| `voice.<name>.stt`           | `string`          | no       | Twilio's speech-to-text provider (`Deepgram`, `Google`).                                                                                         |
| `voice.<name>.texts`         | `Partial<Texts>`  | no       | Lines said to callers, instead of the language's own (see `TEXTS`); `greeting: ""` says none.                                                    |
| `voice.<name>.waiting`       | `string`          | no       | Said once when a turn starts running tools before any answer ("One moment, let me check"), so a caller doesn't hear silence meanwhile.           |
| `voice.<name>.gap`           | `number`          | no       | Hours of quiet after which a caller's next call starts a new chat (`GAP`).                                                                       |
| `voice.<name>.trustCallerId` | `boolean`         | no       | A caller's number is who they are, verified or not: their calls go on in one chat.                                                               |
| `voice.<name>.keys`          | `boolean`         | no       | Keys pressed on the phone come to the agent too (Twilio's `dtmfDetection`).                                                                      |
| `voice.<name>.limits`        | `Partial<Limits>` | no       | How much calls may cost: see `Limits`.                                                                                                           |
| `voice.<name>.keep`          | `number`          | no       | Days its calls' records are kept, once they're over (`KEEP`, 30; 1 at least).                                                                    |

## What it requires

The runtime doesn't start without [`chat`](chat.md), [`spaces`](spaces.md) and
[`contacts`](contacts.md): add them too.

It ships with `copilotz@1.0.0-rc.47`.

## What it does on its own

Some of its work starts without a caller: an event, or the time.

- `voice.erased` runs on `thread.deleted`.
- `voice.forget` runs on `contact.deleted`.
- `voice.prune` calls `voice.prune`, cron 40 3 * * * (UTC). Removes calls' records older than their
  number's `keep` days, once they're over.

## Listing

It breaks 3 listing rules as it is:

- Route "/hooks/voice/:name" isn't under /voice.
- Route "/hooks/voice/:name/over" isn't under /voice.
- Route "/hooks/voice/:name/relay" isn't under /voice.
