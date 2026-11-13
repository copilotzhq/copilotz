---
title: "computers"
description: "Computers: people connect a machine (the computer program, run once, with a one-time code) to a space, and the agents of that space's conversations work on it."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# computers

Computers: people connect a machine (the computer program, run once, with a one-time code) to a
space, and the agents of that space's conversations work on it.

```ts
import { computers } from "copilotz/plugins/compute";
```

## What it keeps

It keeps 5 collections, each on the record: every change to one is an event.

| Collection   | Kept as   | Fields                                                                                                                  |
| ------------ | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `computer`   | documents | `owner`, `name`, `secret`, `pending`, `online`, `seen`, `info`, `approve`, `status`, `at`; private: `pending`, `secret` |
| `desk`       | documents | `in`, `computer`, `owner`, `name`, `online`, `seen`, `info`, `folder`, `approve`, `status`, `answers`, `default`, `at`  |
| `enrollment` | documents | `owner`, `expires`, `in`, `computer`                                                                                    |
| `envVar`     | documents | `space`, `app`, `name`, `value`, `sealed`, `secret`, `computers`, `hint`, `by`, `at`; private: `sealed`                 |
| `preview`    | documents | `computer`, `space`, `folder`, `who`, `port`, `job`, `by`, `visibility`, `at`                                           |

The access rules cover `desk`, `envVar` and `preview`: each document is in a space, and only those
who reach the space reach it.

Its named queries read for callers, as the rules let them:

| Query           | Who outside runs it                            |
| --------------- | ---------------------------------------------- |
| `computer.mine` | people, agents for a person, keys and routines |
| `desk.here`     | people, agents for a person, keys and routines |
| `desk.of`       | people, agents for a person, keys and routines |
| `envVar.apps`   | people, agents for a person, keys and routines |
| `envVar.here`   | people, agents for a person, keys and routines |
| `preview.here`  | people, agents for a person, keys and routines |
| `preview.label` | the app's code                                 |

## What it lets callers do

Of its 26 Actions, people may call 15; agents may call 12; contacts and someone signed out may call
none.

| Action                 | Person | Agent | Contact | Anyone | Key | Routine | Maintenance | What it does                                                                        |
| ---------------------- | ------ | ----- | ------- | ------ | --- | ------- | ----------- | ----------------------------------------------------------------------------------- |
| `computer.allowOrigin` | yes    | no    | no      | no     | no  | no      | no          | Lets an agent do a kind of work at a desk when a routine runs, or stops letting it. |
| `computer.code`        | yes    | no    | no      | no     | no  | no      | no          | A one-time code to connect a computer to a space.                                   |
| `computer.default`     | yes    | yes   | no      | no     | yes | yes     | no          | Makes a computer the one a space's agents use.                                      |
| `computer.forget`      | yes    | yes   | no      | no     | yes | yes     | no          | Forgets one of your computers.                                                      |
| `computer.move`        | yes    | yes   | no      | no     | yes | yes     | no          | Moves one of your computers to another space.                                       |
| `computer.preview`     | yes    | yes   | no      | no     | yes | yes     | no          | Makes an address for what a job on a space's computer serves.                       |
| `computer.previews`    | yes    | yes   | no      | no     | yes | yes     | no          | A space's previews: what its computers serve, at addresses of their own.            |
| `computer.rename`      | yes    | yes   | no      | no     | yes | yes     | no          | Names one of your computers.                                                        |
| `computer.share`       | yes    | yes   | no      | no     | yes | yes     | no          | Puts one of your computers in a space, for its members and their agents.            |
| `computer.unpreview`   | yes    | yes   | no      | no     | yes | yes     | no          | Takes a preview away: its address no longer opens.                                  |
| `computer.unshare`     | yes    | yes   | no      | no     | yes | yes     | no          | Takes a computer out of a space.                                                    |
| `computer.upgradeAsks` | no     | no    | no      | no     | no  | no      | yes         | Keeps computers' old asks and yeses as chat keeps them.                             |
| `computer.view`        | yes    | yes   | no      | no     | yes | yes     | no          | Says you have a space's computer open, so it stays awake while you do.              |
| `computer.work`        | yes    | no    | no      | no     | no  | no      | no          | Works on a space's computer, in its folder there.                                   |
| `env.set`              | yes    | yes   | no      | no     | yes | yes     | no          | Sets a variable or secret of a space's environment (or an app's own).               |
| `env.unset`            | yes    | yes   | no      | no     | yes | yes     | no          | Takes a variable or secret away from a space's environment (or an app's own).       |

An agent works for a person, and calls what both may. A key calls only what its scope names. A
routine is work done for a person, which they set going.

Only the app's own code calls `computer.admit`, `computer.allowed`, `computer.enrollment`,
`computer.gone`, `computer.mark`, `computer.provision`, `computer.ready`, `computer.running`,
`computer.scope` and `env.values`: its plugins, its schedules and the system.

Agents act through its 12 tools, as whoever they work for:

| Tool         | What it does                                                                                                                                                                                                                                                                   | Calls              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `browser`    | Uses your browser on your person's computer: one of your own for this space, with its own profile (never their personal browser), so sign-ins stay between calls.                                                                                                              |                    |
| `edit_file`  | Changes a file in this space's folder: replaces text that occurs exactly once in it (old) with new text.                                                                                                                                                                       |                    |
| `job_logs`   | What one of your background jobs wrote (the end of it, with tail: characters).                                                                                                                                                                                                 |                    |
| `list_files` | Lists a directory in this space's folder (path relative to it; default: the folder).                                                                                                                                                                                           |                    |
| `list_jobs`  | Your background jobs in this space, on one of its computers: running and finished.                                                                                                                                                                                             |                    |
| `preview`    | Makes a link to what one of your background jobs serves (a dev server, a site), for the people of this space to open in their browser: give the job (its id or name; it's found on whichever computer runs it) or the port it serves (and the computer, when not the default). | `computer.preview` |
| `read_file`  | Reads a file in this space's folder (text; base64 when it isn't).                                                                                                                                                                                                              |                    |
| `start_job`  | Starts a command that keeps running in the background (a dev server, a watcher, a long build), in this space's folder, in the terminal's shell (bash, or PowerShell on Windows), with the space's environment (your context names it).                                         |                    |
| `stop_job`   | Stops one of your background jobs.                                                                                                                                                                                                                                             |                    |
| `terminal`   | Runs a command in your own shell on your person's computer, in this space's folder: bash on macOS and Linux, PowerShell on Windows (your context says which this computer has).                                                                                                |                    |
| `web_search` | Searches the web: the top results, each a title, link and snippet.                                                                                                                                                                                                             |                    |
| `write_file` | Writes a whole file in this space's folder, making its directories.                                                                                                                                                                                                            |                    |

It answers 2 routes over HTTP:

| Method | Path                         |
| ------ | ---------------------------- |
| ANY    | `*://*-preview.*:*/*`        |
| GET    | `/__copilotz/previews/grant` |

It also adds rules every read and write keeps to (`guard`) and lets programs outside the app connect
as workers.

## Where it shows

Its Views show to the model.

- **To the model:** `context:computer`.
- **Agents' tools:** `browser`, `edit_file`, `job_logs`, `list_files`, `list_jobs`, `preview`,
  `read_file`, `start_job`, `stop_job`, `terminal`, `web_search`, `write_file`.
- **Front ends:** [`computers-terminal`](computers-terminal.md) and
  [`computers-web`](computers-web.md).
- **What it adds to resources:** `context` (`computer`), `usageNames` (`computer`).

## What it needs

You set it in `resources.computers`, and 1 is a secret, kept out of your code.

| Setting                 | Type                                       | Required | What it is                                                                                      |
| ----------------------- | ------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------- |
| `computers.approve`     | `Exclude<Asked, "publish" \| "destroy">[]` | no       |                                                                                                 |
| `computers.key`         | `string`                                   | no       | Secret. Seals spaces' secrets at rest (their environment): any long secret, from the app's own. |
| `computers.codeMinutes` | `number`                                   | no       | Seals spaces' secrets at rest (their environment): any long secret, from the app's own.         |
| `computers.url`         | `string`                                   | no       | Seals spaces' secrets at rest (their environment): any long secret, from the app's own.         |
| `computers.previews`    | `PreviewsSettings`                         | no       | Seals spaces' secrets at rest (their environment): any long secret, from the app's own.         |

It also reads `computerWake`, `directory`, `downloads`, `org` and `origins`, resource kinds the app
and other plugins fill.

## What it requires

The runtime doesn't start without [`chat`](chat.md) and [`spaces`](spaces.md): add them too.

It ships with `copilotz@1.0.0-rc.47`.

## What it does on its own

Some of its work starts without a caller: an event, or the time.

- `computers.left` runs on `member.deleted`.
- `computer.upgradeAsks` calls `computer.upgradeAsks`, once, when the runtime first starts with it.
  Keeps computers' old asks and yeses as chat keeps them.

## Listing

It breaks 2 listing rules as it is:

- Route "_://_-preview._:_/*" takes whole hosts, not paths under /computers.
- Route "/__copilotz/previews/grant" isn't under /computers.
