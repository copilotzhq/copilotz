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

It keeps 6 collections, each on the record: every change to one is an event.

| Collection   | Kept as   | Fields                                                                                                                             |
| ------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `computer`   | documents | `owner`, `name`, `secret`, `pending`, `online`, `seen`, `info`, `approve`, `status`, `engines`, `at`; private: `pending`, `secret` |
| `desk`       | documents | `in`, `computer`, `owner`, `name`, `online`, `seen`, `info`, `folder`, `approve`, `status`, `answers`, `default`, `at`             |
| `enrollment` | documents | `owner`, `expires`, `in`, `computer`                                                                                               |
| `envVar`     | documents | `space`, `app`, `name`, `value`, `sealed`, `secret`, `computers`, `hint`, `by`, `at`; private: `sealed`                            |
| `jobWatch`   | documents | `computer`, `job`, `name`, `scope`, `thread`, `in`, `agent`, `person`, `origin`, `at`                                              |
| `preview`    | documents | `computer`, `space`, `folder`, `who`, `port`, `job`, `by`, `visibility`, `at`                                                      |

The access rules cover `desk`, `envVar` and `preview`: each document is in a space, and only those
who reach the space reach it.

Its named queries read for callers, as the rules let them:

| Query           | Who outside runs it                            |
| --------------- | ---------------------------------------------- |
| `computer.cost` | people, agents for a person, keys and routines |
| `computer.mine` | people, agents for a person, keys and routines |
| `desk.here`     | people, agents for a person, keys and routines |
| `desk.of`       | people, agents for a person, keys and routines |
| `envVar.apps`   | people, agents for a person, keys and routines |
| `envVar.here`   | people, agents for a person, keys and routines |
| `preview.here`  | people, agents for a person, keys and routines |
| `preview.label` | the app's code                                 |

## What it lets callers do

Of its 35 Actions, people may call 22; agents may call 14; contacts and someone signed out may call
none.

| Action                   | Person | Agent | Contact | Anyone | Key | Routine | Maintenance | What it does                                                                                                     |
| ------------------------ | ------ | ----- | ------- | ------ | --- | ------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `computer.allowOrigin`   | yes    | no    | no      | no     | no  | no      | no          | Lets an agent do a kind of work at a desk when a routine runs, or stops letting it.                              |
| `computer.code`          | yes    | no    | no      | no     | no  | no      | no          | A one-time code to connect a computer to a space.                                                                |
| `computer.default`       | yes    | yes   | no      | no     | yes | yes     | no          | Makes a computer the one a space's agents use.                                                                   |
| `computer.engine`        | yes    | yes   | no      | no     | yes | yes     | no          | Runs one step of an agent's model call on its person's plan, on their computer.                                  |
| `computer.engine.cancel` | yes    | yes   | no      | no     | yes | yes     | no          | Stops what an agent's model call is doing on its person's plan.                                                  |
| `computer.engine.login`  | yes    | no    | no      | no     | no  | no      | no          | Signs a plan's CLI in on one of your computers, step by step.                                                    |
| `computer.engine.logout` | yes    | no    | no      | no     | no  | no      | no          | Signs a plan's CLI out on one of your computers, by its own sign-out.                                            |
| `computer.engines`       | yes    | no    | no      | no     | no  | no      | no          | Your computers, and which plans' CLIs each runs, signed in or not.                                               |
| `computer.forget`        | yes    | yes   | no      | no     | yes | yes     | no          | Forgets one of your computers.                                                                                   |
| `computer.move`          | yes    | yes   | no      | no     | yes | yes     | no          | Moves one of your computers to another space.                                                                    |
| `computer.prepare`       | yes    | no    | no      | no     | no  | no      | no          | Gets one of your computers ready for your plans: awake, on this app's program, and what its plans' CLIs are now. |
| `computer.preview`       | yes    | yes   | no      | no     | yes | yes     | no          | Makes an address for what a job on a space's computer serves.                                                    |
| `computer.previews`      | yes    | yes   | no      | no     | yes | yes     | no          | A space's previews: what its computers serve, at addresses of their own.                                         |
| `computer.rename`        | yes    | yes   | no      | no     | yes | yes     | no          | Names one of your computers.                                                                                     |
| `computer.share`         | yes    | yes   | no      | no     | yes | yes     | no          | Puts one of your computers in a space, for its members and their agents.                                         |
| `computer.unpreview`     | yes    | yes   | no      | no     | yes | yes     | no          | Takes a preview away: its address no longer opens.                                                               |
| `computer.unshare`       | yes    | yes   | no      | no     | yes | yes     | no          | Takes a computer out of a space.                                                                                 |
| `computer.upgradeAsks`   | no     | no    | no      | no     | no  | no      | yes         | Keeps computers' old asks and yeses as chat keeps them.                                                          |
| `computer.upload`        | yes    | no    | no      | no     | no  | no      | no          | Puts a file on a space's computer, in its folder there: where its bytes go.                                      |
| `computer.view`          | yes    | yes   | no      | no     | yes | yes     | no          | Says you have a space's computer open, so it stays awake while you do.                                           |
| `computer.work`          | yes    | no    | no      | no     | no  | no      | no          | Works on a space's computer, in its folder there.                                                                |
| `env.set`                | yes    | yes   | no      | no     | yes | yes     | no          | Sets a variable or secret of a space's environment (or an app's own).                                            |
| `env.unset`              | yes    | yes   | no      | no     | yes | yes     | no          | Takes a variable or secret away from a space's environment (or an app's own).                                    |

An agent works for a person, and calls what both may. A key calls only what its scope names. A
routine is work done for a person, which they set going.

Only the app's own code calls `computer.admit`, `computer.allowed`, `computer.connected`,
`computer.enrollment`, `computer.gone`, `computer.mark`, `computer.provision`, `computer.ready`,
`computer.running`, `computer.scope`, `computer.watch` and `env.values`: its plugins, its schedules
and the system.

Agents act through its 14 tools, as whoever they work for:

| Tool         | What it does                                                                                                                                                                                                                                                                                                              | Calls              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `browser`    | Uses your browser on your person's computer: one of your own for this space, with its own profile (never their personal browser), so sign-ins stay between calls.                                                                                                                                                         |                    |
| `edit_file`  | Changes a file in this space's folder: replaces text that occurs exactly once in it (old) with new text.                                                                                                                                                                                                                  |                    |
| `job_logs`   | What one of your background jobs wrote (the end of it, with tail: characters).                                                                                                                                                                                                                                            |                    |
| `list_files` | Lists a directory in this space's folder (path relative to it; default: the folder).                                                                                                                                                                                                                                      |                    |
| `list_jobs`  | Your background jobs in this space, on one of its computers: running and finished.                                                                                                                                                                                                                                        |                    |
| `preview`    | Makes a link to what one of your background jobs serves (a dev server, a site), for the people of this space to open in their browser: give the job (its id or name; it's found on whichever computer runs it) or the port it serves (and the computer, when not the default).                                            | `computer.preview` |
| `read_file`  | Reads a file in this space's folder (text; base64 when it isn't).                                                                                                                                                                                                                                                         |                    |
| `save_file`  | Saves a file sent in this chat into this space's folder on a computer, where commands and the other tools reach it (a zip to unpack, data to work on, an image to edit). file: its id, as its message shows it ([file … id file-…]). path: where in the folder (default: its name, at the top); a file there is replaced. |                    |
| `send_file`  | Sends a file from this space's folder on a computer into this chat, for its people to open or download (a report, a chart, a zip you made): up to about 10 MB. text: what you say with it, if anything.                                                                                                                   |                    |
| `start_job`  | Starts a command that keeps running in the background (a dev server, a watcher, a long build), in this space's folder, in the terminal's shell (bash, or PowerShell on Windows), with the space's environment (your context names it).                                                                                    |                    |
| `stop_job`   | Stops one of your background jobs (you aren't told it ended: you stopped it).                                                                                                                                                                                                                                             |                    |
| `terminal`   | Runs a command in your own shell on your person's computer, in this space's folder: bash on macOS and Linux, PowerShell on Windows (your context says which this computer has).                                                                                                                                           |                    |
| `web_search` | Searches the web: the top results, each a title, link and snippet.                                                                                                                                                                                                                                                        |                    |
| `write_file` | Writes a whole file in this space's folder, making its directories.                                                                                                                                                                                                                                                       |                    |

It answers 3 routes over HTTP:

| Method | Path                         |
| ------ | ---------------------------- |
| ANY    | `*://*-preview.*:*/*`        |
| GET    | `/__copilotz/previews/grant` |
| PUT    | `/computers/upload`          |

It also adds rules every read and write keeps to (`guard`) and lets programs outside the app connect
as workers.

Other plugins call it through its adapters: `llm` (`engine`).

## Where it shows

Its Views show to the model.

- **To the model:** `context:computer`.
- **Agents' tools:** `browser`, `edit_file`, `job_logs`, `list_files`, `list_jobs`, `preview`,
  `read_file`, `save_file`, `send_file`, `start_job`, `stop_job`, `terminal`, `web_search`,
  `write_file`.
- **Front ends:** [`computers-terminal`](computers-terminal.md) and
  [`computers-web`](computers-web.md).
- **What it adds to resources:** `connectedPlans` (`computers`), `context` (`computer`), `cost`
  (`claude-plan/*`, `codex-plan/*`, `cursor-plan/*`, `gemini-plan/*`, `grok-plan/*`), `provider`
  (`claude-plan`, `codex-plan`, `cursor-plan`, `gemini-plan`, `grok-plan`), `usageNames`
  (`computer`).

## What it needs

Nothing to set. It reads `computerWake`, `directory`, `downloads`, `org`, `origins` and `provider`,
resource kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`chat`](chat.md) and [`spaces`](spaces.md): add them too.

It ships with `copilotz@1.0.0-rc.66`.

## What it does on its own

Some of its work starts without a caller: an event, or the time.

- `computers.left` runs on `member.deleted`.
- `computer.upgradeAsks` calls `computer.upgradeAsks`, once, when the runtime first starts with it.
  Keeps computers' old asks and yeses as chat keeps them.

## Listing

It breaks 2 listing rules as it is:

- Route "_://_-preview._:_/*" takes whole hosts, not paths under /computers.
- Route "/__copilotz/previews/grant" isn't under /computers.
