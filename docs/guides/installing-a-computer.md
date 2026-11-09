---
title: "Installing a computer"
description: "People connect their own machines for their agents to work on: where the computer program comes from, the one line that installs it, and what it does on the machine."
section: Guides
order: 5
---

# Installing a computer

A person connects their own machine with one line, and their agents can then work on it once they
say yes.

A computer belongs to a space. An agent uses a computer of the space its chat is in, for the person
it works for, and only where that person reaches. Only the person says yes: an agent, a key or a
routine can't answer for them, since `computer.approve` is `inPerson`.

## Where the program comes from

People's computers run the computer program, `plugins/compute/computers/program/`. It's a single
executable for macOS, Linux and Windows.

Each Copilotz release on GitHub has it, tagged `v<version>`. A release holds a binary per platform,
`install.sh`, `install.ps1`, and `manifest.json` with their sizes and SHA-256.

An app serves it from there by default. It can also serve a folder of its own, or point elsewhere:

```ts
import { computerDownloads } from "copilotz/plugins/compute/downloads";

plugins: [...plugins, await computerDownloads()], // this Copilotz's release
plugins: [...plugins, await computerDownloads({ dir: "dist/computer/1.0.0-rc.34" })], // its own: /computer/download/
plugins: [...plugins, await computerDownloads({ url: "https://downloads.example.com/computer/" })], // or elsewhere
```

`computerDownloads` serves the program on Node.

## How a release is built

The publish workflow builds the program when a `v1.*` tag is pushed. It runs on a Mac, where the
macOS binaries are signed.

A release whose program is the same as the last one's takes that release's binaries, version and
all, so computers don't update to what they already have. The manifest's `source` says what the
program is: a hash of its code without its version, its install scripts and the Bun that builds it.

To build one yourself:

```sh
node scripts/computer/build.ts                 # dist/computer/<version>/
node scripts/computer/build.ts --reuse <url>   # that release's, when it's the same program
```

## The one line

A space's Computer tab, or `/computer connect` in the terminal, gives the one line to run on the
machine, for its system. It has a one-time code in it. The tab also offers the binaries, to download
instead.

On macOS and Linux:

```sh
curl -fsSL https://app.example.com/computer/download/install.sh | sh -s -- https://app.example.com --code K7Q-4MZ
```

On Windows:

```powershell
& ([scriptblock]::Create((irm https://app.example.com/computer/download/install.ps1))) https://app.example.com -Code K7Q-4MZ
```

## What the line does

1. It downloads that machine's binary.
2. It checks its SHA-256 against the release's manifest.
3. It puts it in `~/.copilotz/bin` (`%LOCALAPPDATA%\Copilotz\bin` on Windows), on the PATH.
4. It connects it with the code.
5. It keeps it running from login on: a launchd agent on macOS, a systemd user unit on Linux, a
   scheduled task on Windows.

The binaries aren't signed yet, so macOS and Windows warn about one downloaded with a browser. The
line doesn't need that.

## On the machine

- `computer uninstall` stops it, and `computer install` starts it again.
- `computer forget` forgets it.
- `computer run` runs it in the foreground instead.
- `computer list` says which apps it's connected to, and where their spaces are.
- `computer disconnect <app-url>` leaves one app.

Its commands run in bash. On Windows they run in PowerShell, 7 when it's there, else 5.1. Agents are
told which.

## Updates

A computer older than the app's release updates itself as it connects. The app tells it the version,
and its binary's URL, size and SHA-256. The computer checks them, checks that the new one runs,
swaps it in and starts again.

## Many apps on one machine

One machine can serve several apps, or several orgs of one. Run the line from each, and each is a
computer of its own there, in one program.

Each one's spaces go in a folder of its own under `~/Copilotz`. It's named for the org, which the
line from an org says (`--folder acme`), or else for the app's host.

## In Build Compass

[Chapter 38](../build-compass/part-12-shipping/38-a-computer-for-your-agents.md) connects a machine
to Compass, where North gets a terminal, jobs, files, a browser and web search, and asks before it
runs anything.
