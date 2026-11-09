---
title: "spaces"
description: "Spaces: who reaches what, for every collection that shares its documents."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# spaces

Spaces: who reaches what, for every collection that shares its documents.

```ts
import { spaces } from "copilotz/plugins/access";
```

## What it keeps

It keeps 5 collections, each on the record: every change to one is an event.

| Collection   | Kept as   | Fields                                                   |
| ------------ | --------- | -------------------------------------------------------- |
| `invitation` | documents | `space`, `name`, `email`, `role`, `by`, `at`             |
| `member`     | documents | `member`, `space`, `role`, `on`                          |
| `profile`    | documents | `name`, `picture`, `at`                                  |
| `request`    | documents | `space`, `member`, `by`, `reason`, `at`                  |
| `space`      | documents | `name`, `kind`, `owner`, `archived`, `agent`, `declared` |

Its named queries read for callers, as the rules let them:

| Query              | Who outside runs it                            |
| ------------------ | ---------------------------------------------- |
| `invitation.mine`  | people, agents for a person, keys and routines |
| `profile.names`    | people, agents for a person, keys and routines |
| `profile.pictures` | people, agents for a person, keys and routines |
| `request.open`     | people, agents for a person, keys and routines |
| `space.handoffs`   | people, agents for a person, keys and routines |
| `space.reached`    | people, agents for a person, keys and routines |

## What it lets callers do

Of its 28 Actions, people may call 23; agents may call 8; contacts and someone signed out may call
none.

| Action               | Person | Agent | Contact | Anyone | Key | Routine | What it does                                                                                                               |
| -------------------- | ------ | ----- | ------- | ------ | --- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `invitation.accept`  | yes    | no    | no      | no     | no  | no      | Joins the space an invitation to your email is for.                                                                        |
| `invitation.decline` | yes    | no    | no      | no     | no  | no      | Turns down an invitation to your email; a space's managers take one back.                                                  |
| `invitation.send`    | yes    | no    | no      | no     | no  | no      | Invites someone into a shared space by email, with a role; they join once they accept.                                     |
| `member.remove`      | yes    | no    | no      | no     | no  | no      | Removes someone from a space.                                                                                              |
| `member.set`         | yes    | no    | no      | no     | no  | no      | Makes someone a member of a space, with a role.                                                                            |
| `org.invite`         | yes    | no    | no      | no     | no  | no      | Invites someone to the org by email, with a role; they join when they accept.                                              |
| `org.invites`        | yes    | yes   | no      | no     | yes | yes     | The org's invitations waiting to be accepted.                                                                              |
| `org.me`             | yes    | yes   | no      | no     | yes | yes     | Your standing in the org: your role, whether you're platform staff, and the org (in an app serving many).                  |
| `org.people`         | yes    | yes   | no      | no     | yes | yes     | Who's in the org, with their roles, names and emails: for its members.                                                     |
| `org.remove`         | yes    | no    | no      | no     | no  | no      | Takes someone out of the org: their memberships end, and the shared spaces only they managed go to `to` (you, by default). |
| `org.rename`         | yes    | no    | no      | no     | no  | no      | Renames the org: its owners'.                                                                                              |
| `org.role`           | yes    | no    | no      | no     | no  | no      | Changes someone's role in the org.                                                                                         |
| `org.uninvite`       | yes    | no    | no      | no     | no  | no      | Takes back an invitation to the org.                                                                                       |
| `request.deny`       | yes    | no    | no      | no     | no  | no      | Turns a request down.                                                                                                      |
| `request.grant`      | yes    | no    | no      | no     | no  | no      | Lets in whoever a request is for, with a role (viewer by default).                                                         |
| `share`              | yes    | no    | no      | no     | no  | no      | Shows a labelled document to everyone where it is.                                                                         |
| `space.agent`        | yes    | yes   | no      | no     | yes | yes     | Chooses the agent that answers a space's new chats: one working there.                                                     |
| `space.archive`      | yes    | yes   | no      | no     | yes | yes     | Archives a space you manage, or brings it back.                                                                            |
| `space.can`          | yes    | yes   | no      | no     | yes | yes     | Whether you may read, write in or manage a space.                                                                          |
| `space.create`       | yes    | no    | no      | no     | no  | no      | Makes a space (a shared one, an org…); its maker manages it.                                                               |
| `space.leave`        | yes    | no    | no      | no     | no  | no      | Leaves a shared space you're in.                                                                                           |
| `space.personal`     | yes    | yes   | no      | no     | yes | yes     | Your Personal space, where what you make alone lives.                                                                      |
| `space.rename`       | yes    | yes   | no      | no     | yes | yes     | Renames a space you manage.                                                                                                |

An agent works for a person, and calls what both may. A key calls only what its scope names. A
routine is work done for a person, which they set going.

Only the app's own code calls `org.join`, `org.seats`, `org.summary`, `space.keep` and
`space.roster`: its plugins, its schedules and the system.

Agents act through its tool, as whoever they work for:

| Tool             | What it does                                                                             | Calls |
| ---------------- | ---------------------------------------------------------------------------------------- | ----- |
| `request_access` | Ask the managers of a space you can't see to let the person you work for in, saying why. |       |

It also adds rules every read and write keeps to (`guard`) and carries what a job read to what it
writes (`labels`).

## Where it shows

Its Views show to the model.

- **To the model:** `context:elsewhere`, `context:where`.
- **Agents' tools:** `request_access`.
- **Front ends:** [`spaces-terminal`](spaces-terminal.md) and [`spaces-web`](spaces-web.md).
- **What it adds to resources:** `context` (`elsewhere`, `where`), `names` (`people`), `roster`
  (`spaces`), `usageNames` (`space`).

## What it needs

Nothing to set. It reads `agents`, `directory`, `names`, `org`, `roles`, `shared` and `spaces`,
resource kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`identity`](identity.md): add it too.

It ships with `copilotz@1.0.0-rc.33`.

## What it does on its own

Some of its work starts without a caller: an event, or the time.

- `spaces.agentGone` runs on `agent.deleted`.
- `spaces.profile` runs on `person.created` or `person.updated`.

## Listing

It keeps every listing rule.
