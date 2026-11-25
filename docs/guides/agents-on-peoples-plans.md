---
title: "Agents on people's own plans"
description: "An agent's model calls can run on the plan of the person it works for (Claude, ChatGPT through Codex, Google AI through Antigravity), through the plan's CLI on a computer of theirs: the providers, signing in once (installing a missing CLI), signing out, what a cloud computer keeps, what runs where, waking a computer that sleeps, and what a plan costs."
section: Guides
order: 6
---

# Agents on people's own plans

People who pay for a plan (Claude, ChatGPT, Google AI) can have their agents run on it instead of on
the app's API key. The plan's CLI does the model call on a computer of theirs: Claude Code, Codex or
Antigravity. It is signed in once there, and serves every conversation and space of theirs in the
org.

The CLI is only the engine. The agent stays the app's own: its instructions replace the CLI's, the
CLI's built-in tools are off (files, shell, the web), and the agent's tools reach it from the
computer program, as MCP tools, and run where every tool runs, with the same rules and asks.

## The providers

The computers plugin adds three model providers:

| Provider      | Runs on                     | The CLI     |
| ------------- | --------------------------- | ----------- |
| `claude-plan` | the person's Claude plan    | Claude Code |
| `codex-plan`  | the person's ChatGPT plan   | Codex       |
| `gemini-plan` | the person's Google AI plan | Antigravity |

An agent names one first, and an API model next for when it can't run:

```ts
agents: {
  north: { instructions, model: ["claude-plan/claude-opus-5-5", "anthropic/claude-opus-5-5"] },
}
```

It can't run when nobody's there (a routine runs on its own), when the person hasn't signed the plan
in on a computer of theirs, when that computer is off, or when the plan's limit is reached. The list
then moves on at once: a person with no plan signed in costs the call no wait. Its uses are metered,
tagged `paid: "subscription"`, at no cost to the app.

## Signing in, once

A person signs a plan in from Connected accounts (`computer.engines` lists their computers and the
CLIs each has; `computer.engine.login` runs a CLI's own sign-in there):

- **On their own machine,** the CLI opens their browser, and that's all.
- **On a cloud computer,** it shows a link; the page it opens shows a code, which goes back to it.

The sign-in stays on the computer, in a folder the computer program keeps for each CLI, apart from
the person's own use of it. The app keeps only whether it's done, and as whom.

A plan runs only on its person's own computer, and never on one shared into a space where others'
agents work on it as them: the sign-in would be theirs to reach.

### A missing CLI

On macOS and Linux, Sign in installs a CLI that isn't there yet. The dialog says what it runs on
that computer (the plan's official installer), and its button is "Install Claude Code and sign in":
the person's click is the consent. The installer runs in the computer's home, then the sign-in
starts. An installer that fails shows what it said last, and the command to run by hand. On Windows,
the page shows the command to run, as before.

From code, `install: true` asks for the same on the first call; later calls poll as any sign-in's:

```ts
let step = await runtime.call("computer.engine.login", {
  computer,
  engine: "claude",
  install: true,
}, { actor: person });
while (step.state === "running") {
  step = await runtime.call("computer.engine.login", { computer, engine: "claude" }, {
    actor: person,
  });
}
```

What runs is the app's own command for the plan (`curl -fsSL https://claude.ai/install.sh | bash`,
`npm i -g @openai/codex`, Antigravity's script), never one the caller gives.

### Signing out

`computer.engine.logout` (Sign out, in the menu of a computer's line on the plan) runs the CLI's own
sign-out on that computer, in the folder the program keeps for it: `claude auth logout`,
`codex logout`. Their sign-ins are kept there, so when that fails the folder goes instead. The
person's own sign-in (`~/.claude`, `~/.codex`) is never touched. Antigravity has no sign-out of its
own here (its sign-in may be in the system's keyring): signing it out fails (`unsupported`), saying
to sign out in Antigravity on that computer. A cloud computer wakes to sign out; a laptop must be
on.

```ts
await runtime.call("computer.engine.logout", { computer, engine: "claude" }, { actor: person });
```

A cloud computer signed in to a plan isn't shared into a space where others' agents work on it as
them (they answer to whoever they work for, outside a Personal space). `computer.share` and
`computer.move` refuse it (`plan_signed_in`), and the page says to sign out of it first, with a link
to the plans. Keeping the yes to oneself there (`answers: "owner"`) isn't sharing it with others'
agents, so it may go.

A person's own computer is theirs to share, signed in or not. Sharing it, the page says what it
means: the space's agents run on it as them, and can read everything they can there, their own
sign-ins included (Claude Code, Codex, SSH keys). Either way, a computer shared with others' agents
never runs anyone's plan, and its plans can't sign in there.

## What a cloud computer keeps

A cloud computer serves each wake on a new VM, and only its disk lasts. So its work (its terminal,
jobs, the plans' CLIs and its browser) runs in a home on the disk: `HOME` is `<disk>/home`, npm's
global prefix is under it (`NPM_CONFIG_PREFIX=<disk>/home/.npm-global`), and the folders both put
programs in come first on the `PATH`. A CLI installed there, by Sign in or from its terminal, is
there on its next wake, signed in as it was. A person's own computer keeps their own home.

## What runs where

One step of a turn is one call. The computer program keeps a session per conversation in the CLI. A
tool call ends the step while the CLI waits; the turn runs the tool, and the next step gives the CLI
its answer and goes on with the same answer. The next turn goes on in the same session with only
what's new, as long as what it was given is still what the conversation says. Otherwise (edited,
summarized, other instructions or tools) a fresh session is given the whole history: the
conversation is the truth, a session only saves time.

A step whose stream breaks (the app redeployed, the network) comes back to the same answer, from
where the step began.

The computer program speaks the Agent Client Protocol to the CLIs: Antigravity speaks it itself, and
the program's own adapters speak it for Claude Code and Codex. None of them is shipped with the
program: people install the CLI they use, or Sign in installs it.

## Waking a computer

A cloud computer sleeps when it isn't used, and a plan's call wakes it. The computers plugin asks
the app that keeps it, through the `computerWake` resource:

```ts
resources: {
  computerWake: {
    wake: "cloud.wake", // wakes one: { computer }
    touch: "cloud.touch", // told of every use: { computer }
    estimate: "cloud.estimate", // how long a wake takes now: { seconds, slower? }
    prices: "cloudComputer.sizes", // what they cost (see below)
  },
}
```

- **It says so.** Before it waits, the call sends a `waking` chunk with the app's estimate. Chat
  shows "Waking the computer… (about 5 seconds)", or "…(about 40 seconds: it takes longer at this
  hour)" when the estimate says it's `slower`. Past that time, it says "Still waking the computer…".
  It says "the computer", not "yours": everyone in the conversation sees it.
- **It checks, after.** Once awake, the computer is asked what the plan's CLI is now
  (`computer.agents.status`), and what it says is kept. A CLI that isn't signed in any more (it
  went, or its sign-in lapsed while the computer slept) is passed over for the next computer at
  once. With none left, the model list moves on.
- **Off isn't asleep.** A person's laptop that's off isn't woken, and nothing says it's waking.
- **A running step is use.** The computer is told it's used as a step starts, every minute while it
  runs, and once more when it ends. So the app's idle check never puts it to sleep mid-step, and it
  stays warm after.

## What a plan costs

**The model.** Tiers price a typical message for the person looking, at the first model their turn
would try: their plans first (`modelChoice.offered`).

- On one of their plans, a kind of work costs them nothing (`ModelShown.plan`).
- A tier says what it comes to for them (`TierShown.yours`) where a plan of theirs answers. The
  composer then reads "Everyday · on your plans · model $0", or "Everyday · 2¢" with no plan
  connected.
- `price` stays what it costs on the app's models. The org's and a space's pages, which choose for
  others, show it.

**The computer.** A computer the app keeps is charged while it's awake. `computer.cost` (a query,
`{ computer? }`; none means a new one) says what it costs the person asking:

- an hour awake, at its size's price;
- how long it stays awake after its last use;
- its disk, a month;
- how far the org plan's credits go at that, after a month's disk (`planCredits`);
- for one of theirs, this month so far, from the usage ledger.

The app says the prices: `computerWake.prices` names a query answering `ComputerPrices` (each size's
hour, the disk's GB and its price a GB-month, `warmMinutes`). Nothing is priced in Copilotz. The
`computer.cost` View says it in a line, by `hints.mode`:

| Mode    | It says                                                                                                                       |
| ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `price` | "About 16¢ per hour of work, and it sleeps 10 minutes after. Your $5 covers about 18 hours of work, after this month's disk." |
| `cost`  | "About 16¢ per hour of work, and it sleeps 10 minutes after."                                                                 |
| `month` | "This month: 2h 40m awake · $0.43 · disk $2.00"                                                                               |

It draws nothing for a person's own machine, or where the app prices none. Connected accounts says
"Your plan pays for the AI.", and, where the app keeps computers, "A cloud computer you use for it
is charged while it's awake."

## Known limits

- A shared computer is shared whole: agents in its spaces can read everything on it, sign-ins kept
  there included. Keep personal sign-ins on a computer you don't share.
- Antigravity can't be signed out from here: its sign-in may be in the system's keyring, beside the
  person's own use of it.
- On a laptop, a CLI installed where the program doesn't look (npm's prefix under a version manager,
  not on the program's `PATH`) isn't found: the page then shows the command to run by hand.
- A computer program older than 1.0.0-rc.65 neither installs a CLI nor signs one out: Sign in says
  it's missing, and Sign out fails, until it updates.
- The estimate takes a plan as it last said: a plan at its limit still shows $0.
- A wake's time is an estimate. Past it, the notice says "Still waking…".
- A tool run on the server for longer than a cloud computer stays warm lets it sleep between steps:
  the next step starts a fresh session, given the whole conversation.
- A CLI removed while its computer is awake still shows as signed in until the computer is asked
  again.
- "This month" is the calendar month in UTC. The disk shows at its monthly price, at the app's disk
  size now.
- "Covers about N hours" counts the plan's credits, not what's left of them.
