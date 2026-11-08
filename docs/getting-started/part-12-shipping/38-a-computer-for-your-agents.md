---
title: "Chapter 38: A computer for your agents"
description: "Run Copilotz's computers plugin, unchanged, on Compass's spaces: a machine you connect with a one-time code, where North gets a terminal, jobs, files, a browser and web search, and asks before it runs anything. One change to spaces makes it fit: you are a member of your spaces, the way Copilotz's keep it."
section: Getting Started
order: 380
status: stable
---

# Chapter 38: A computer for your agents

> Part 12, shipping · Requires: Chapter 37 · Code: `lesson-12.3`

## The pain

North can plan the work, put it on the board and argue about it, but it can't try anything. "Does
the test pass?" gets an opinion. "Is this page up?" gets a guess. The work stops where something has
to actually run.

## The problem

An agent that runs things needs a machine, and the machine is yours: what runs there runs as you. So
it has to be one you chose to connect, the agent has to ask before it runs a command, starts a job
or writes a file, and its work has to stay in a folder for the space it's in.

Copilotz has all of this: the `computers` plugin (`copilotz/plugins/compute`), and the computer
program people run on their machine. It requires `chat` and `spaces`, and Compass has both, so the
plan is to import it as it is.

But it doesn't start working at once. Ask it for a code to connect a machine to your Personal space
(`computer.code`), and it answers `You can't work in this space.` Copilotz's computers don't ask
spaces whether you may work there through `space.can`; they import `must` from Copilotz's own
spaces' contract, and `must` asks what you reach, which is worked out from the `member` collection
directly: the spaces you're a member of, with your role there. Compass's spaces seated only the
agents: in a space for one person, you didn't need to be a member of anything. To Copilotz's
computers, you're in no space at all.

## The solution

### You, a member of your spaces

The fix is in your spaces, and it's the contract's own shape: Copilotz's spaces keep the person who
makes a space as its member,
`{ _id: "<space>|person:<you>", space, member: "person:<you>", role:
"manager" }`. Compass's do the
same now (`plugins/spaces/shared/agents.ts`):

```ts
/**
 * You, as a member of a space, the way Copilotz's spaces keep it: its manager.
 * Copilotz's computers read this row to know you may work there.
 */
export const yourSeat = (space: string, person: string) => ({
  _id: `${space}|person:${person}`,
  space,
  member: `person:${person}`,
  role: "manager",
});

/** Who's in a space: you, and the app's agents (boards read them to offer them as owners). */
export async function seat(tx: TransactionScope, space: string, person: string, agents: string[]) {
  await tx.db.collection("member").insertOne(yourSeat(space, person));
  for (const agent of agents) {
    await tx.db.collection("member").insertOne({
      _id: `${space}|agent:${agent}`,
      space,
      member: `agent:${agent}`,
      role: "editor",
    });
  }
}
```

`space.create` and `space.personal` seat you with the agents. Your store already has spaces from
before this lesson, with no row for you, so `space.personal`, which the terminal and the page call
every time they start, seats you in those too (`actions/personal.ts`):

```ts
await ctx.as().transaction(async (tx) => {
  // Spaces made before you were a member of yours: you are now.
  const seated = await tx.db.collection("member").find({ member: `person:${you.person}` });
  for (const space of await tx.db.collection("space").find({})) {
    if (!seated.some((m) => m.space === space._id)) {
      await tx.db.collection("member").insertOne(yourSeat(space._id, you.person));
    }
  }
  if (await tx.db.collection("space").findOne({ _id: id })) return;
  // …
  await seat(tx, id, you.person, agents);
});
```

The agents keep their role, `editor`. When North acts for you, Copilotz's spaces give it what you
both reach: read and write, in your spaces.

### The plugin, and the agents' tools

`app.ts` adds `computers` after `spaces`, which it requires:

```ts
import { computers } from "copilotz/plugins/compute";
// …
export function plugins(settings: Settings): Plugin[] {
  return [
    models,
    chat,
    history,
    identity,
    spaces,
    boards,
    documents,
    memory,
    // Memories on their own, only where there's a model to write them.
    ...(settings.openai ? [memoryExtraction] : []),
    coordination,
    skills,
    routines,
    computers,
    // The computers plugin has a web_search of its own, run on the computer; Compass's is
    // webTools', on any machine: the computer's goes before webTools adds its own.
    definePlugin({ name: "web-search-from-webtools", resources: { tools: { web_search: null } } }),
    webTools,
    mcp,
    compass,
    settingsPlugin(settings),
  ];
}
```

The computer's tools aren't offered on their own, the way the board's are: an agent lists them in
its `tools`, by name. Every agent of the team gets them, next to `send_message`, and North keeps the
web's tools from Chapter 29 (`plugins/compass/resources/agents.ts`):

```ts
/** What an agent does on the space's computer: its shell, jobs, files and browser. */
export const COMPUTER = [
  "terminal",
  "start_job",
  "list_jobs",
  "job_logs",
  "stop_job",
  "list_files",
  "read_file",
  "write_file",
  "edit_file",
  "browser",
];

/** The tools each of them lists: asking a teammate (or you) for something, and the computer. */
const tools = ["send_message", ...COMPUTER];

export const north: Agent = {
  name: "North",
  // …
  model: "north",
  tools: [...tools, "web_search", "read_page"],
  default: true,
  // …
};
```

East, South and West list `tools`. Copilotz's `preview` tool is left out: it gives what a job serves
an address of its own, which needs a domain for previews that the app names
(`computers: { previews }`), and Compass on your machine has none.

An agent with computer tools also gets, each turn, the `computer` context: whose computer this space
has, whether it's online, where its folder is and what waits for a yes; or that there's none yet. An
agent without them doesn't get it. And the charter says what the computer is for
(`plugins/compass/resources/charter.ts`):

```text
**The computer**, when one is connected to the space: files, tests, prototypes, calculations, the
web. Use it to make things real instead of arguing, and report what actually ran, not what you
meant to run.
```

### On the web

`front.ts` adds Copilotz's `computersWeb`: each space's **Computer** tab, where you connect one, and
the cards in a conversation where you say yes to what North asks to run.

```ts
import { computersWeb } from "copilotz/plugins/compute/web";
// …
export const front: Plugin[] = [
  webShell,
  chatWeb,
  spacesWeb,
  boardsWeb,
  documentsWeb,
  memoryWeb,
  skillsWeb,
  routinesWeb,
  computersWeb,
  compassWeb,
  compassTheme,
];
```

And `server.ts` says where the computer program is downloaded from: `computerDownloads()`, this
Copilotz's own release on GitHub, whose manifest it reads once, as it starts. That's a request to
the internet, so a failure is said and passed over:

```ts
// The computer program's release, read once (it's online): without it, a space's Computer tab
// gives the command that runs the program from Copilotz's code instead.
const downloads = await computerDownloads().catch((error) => {
  console.error(`Computer downloads unavailable: ${(error as Error).message}`);
  return undefined;
});
const runtime = await createRuntime({
  // …
  plugins: [
    ...plugins({ you: me, openai: process.env.OPENAI_API_KEY }),
    metrics(meter),
    ...(downloads ? [downloads] : []),
    webPage,
    // …
  ],
});
```

### Connecting your machine

The README's new section, "Installing a computer", says it step by step. In short: start Compass on
the web (`npm run dev`), open a space's Computer tab, and it gives you a one-time code (good for 10
minutes) inside the one line to run for your system:

```sh
curl -fsSL https://github.com/copilotzhq/copilotz/releases/download/v1.0.0-rc.29/install.sh \
  | sh -s -- http://127.0.0.1:8080 --code XCVG-DAFG
```

The script downloads the program for your system, checks its SHA-256 against the release's manifest,
puts it in `~/.copilotz/bin`, connects it with the code and keeps it running. The program connects
to the app's socket as a `computer` worker, and the plugin's `computer.admit` decides who it is:
with `code:<code>`, a new computer of yours, at a desk in the space the code was for. Each space
gets a folder of its own in `~/Copilotz`. The first computer a space has is the one its agents use.

Compass listens on this machine alone, so the computer you connect is this machine. And it connects
to Compass on the web: the terminal doesn't listen for anything, and only one process writes the
store at a time, so Copilotz's `computersTerminal` (`/computer connect`, `/approve`) is left out.
Agents ask before they run a command, start a job or write a file; you answer on the card in the
conversation: once, for the conversation, or always.

## Run it

The terminal shows what North is sent, with `/prompt`. No machine is connected here, and the
`computer` context says so, after the conversation:

```text
Compass
Ana → north › Hi North
north › You said: Ana: Hi North
ana › /prompt
── tools · north
terminal, start_job, list_jobs, job_logs, stop_job, list_files, read_file,
write_file, edit_file, browser, web_search, read_page, list_boards, read_board,
create_board, create_card, update_card, move_card, list_documents,
read_document, write_document, append_document, edit_document, remember, recall,
 forget, list_conversations, read_conversation, read_skill, schedule_routine,
list_routines, cancel_routine, send_message
── system (cached across turns)
# North
…
**The computer**, when one is connected to the space: files, tests, prototypes,
calculations, the
web. Use it to make things real instead of arguing, and report what actually
ran, not what you
meant to run.
…
── turn (what's new, then kept in the history)
<context name="computer">
This space has no computer, so your computer tools won't work until someone
connects one, or adds one of theirs (in the terminal: /computer connect or
/computer share; on the web: the space's Computer tab).
</context>
…
```

That context is Copilotz's text, and it names `/computer connect` for apps whose terminal has it; in
Compass, it's the Computer tab.

Copilotz's `computers` has a `web_search` tool of its own, which searches from the connected
computer. Resources merge field by field, so two plugins declaring one tool would blend; a small
plugin between the two removes the computer's (`null` removes a resource, as JSON Merge Patch does),
and webTools then declares its own, whole.

## Check it

`plugins/spaces/tests/computers.test.ts` runs Copilotz's computers on Compass's spaces, offline:
North's prompt has the ten computer tools and says the space has no computer; `computer.code` gives
you a code for your Personal space; the program's first connection is admitted as the runtime admits
it (`computer.admit` with `code:<code>`, as the system), and coming again with the same code gets
that same computer or nothing, never a second one; the computer has a desk in `personal:ana`, in the
folder `personal`, the space's default; and now North is told this space's computer is offline. The
machine itself, the program and its socket, isn't in the test.

The second test is parity: the same scenario on Copilotz's own identity and spaces (Compass's boards
and MCP server left out), and on Compass's, must answer the same.

```text
✔ North gets a computer in your Personal space, on Compass's spaces
✔ the same on Copilotz's identity and spaces
```

## Also in this chapter

- `README.md`: the section "Installing a computer".
- `plugins/compass/mod.ts`: exports `COMPUTER`, which the test reads.
- `plugins/spaces/mod.ts`: its doc comment says who's in each space: you, its manager, and the
  agents, its editors.
- `plugins/spaces/actions/create.ts`: seats you, with the agents.

`git diff lesson-12.2 lesson-12.3` shows every change.

## What you have now

Compass, shipped: on SQLite or PostgreSQL, with large values in a folder, measured, and with a
computer for North, on your own machine, that asks before it runs anything. The plugin that does the
most here is Copilotz's, unchanged, running on spaces you wrote. That's the contract working.
