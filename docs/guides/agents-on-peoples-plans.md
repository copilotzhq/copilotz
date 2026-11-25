---
title: "Agents on people's own plans"
description: "An agent's model calls can run on the plan of the person it works for (Claude, ChatGPT, Google AI through Antigravity, Grok), through the plan's CLI on a computer of theirs: the providers, plans first and in the person's order, connecting plans in one flow (a computer readied, a missing CLI installed, signed in, tested), Your AI, signing out, which computer a call runs on, a plan at its limit, what a cloud computer keeps, what runs where, waking a computer that sleeps, and what a plan costs."
section: Guides
order: 6
---

# Agents on people's own plans

People who pay for a plan (Claude, ChatGPT, Google AI, Grok) can have their agents run on it instead
of on the app's API key. The plan's CLI does the model call on a computer of theirs: Claude Code,
Codex, Antigravity or Grok Build. It is signed in once there, and serves every conversation and
space of theirs in the org. (ChatGPT also runs on the server, with no computer: the accounts
plugin's `chatgpt`.)

The CLI is only the engine. The agent stays the app's own: its instructions replace the CLI's, the
CLI's built-in tools are off (files, shell, the web), and the agent's tools reach it from the
computer program, as MCP tools, and run where every tool runs, with the same rules and asks.

## The providers

The computers plugin adds four model providers:

| Provider      | Runs on                     | The CLI     | Serves                     |
| ------------- | --------------------------- | ----------- | -------------------------- |
| `claude-plan` | the person's Claude plan    | Claude Code | Anthropic's models         |
| `codex-plan`  | the person's ChatGPT plan   | Codex       | OpenAI's models            |
| `gemini-plan` | the person's Google AI plan | Antigravity | Google's models            |
| `grok-plan`   | the person's Grok plan      | Grok Build  | xAI's models (`grok-4.7`…) |

An agent may name one first, and an API model next for when it can't run:

```ts
agents: {
  north: { instructions, model: ["claude-plan/claude-opus-5-5", "anthropic/claude-opus-5-5"] },
}
```

It can't run when nobody's there (a routine runs on its own), when the person hasn't signed the plan
in on a computer of theirs, when that computer is off, or when the plan's limit is reached. The list
then moves on at once: a person with no plan signed in costs the call no wait. Its uses are metered,
tagged `paid: "subscription"`, at no cost to the app.

## Plans first

With the tiers plugin, a tier names models, and each turn runs them on its person's plans first:

```ts
tiers: {
  expert: {
    title: "Expert",
    agents: { north: [{ model: "anthropic/claude-opus-5-5", effort: "medium" }, "openai/gpt-6.2-sol"] },
  },
}
```

For each model, in the chain's order, every plan of the person's that serves it comes first, in the
person's order; then the API entries, as the chain lists them. Someone with only ChatGPT gets
`chatgpt/gpt-6.2-sol`, then Anthropic's API, then OpenAI's; someone with Claude and ChatGPT gets
`claude-plan/claude-opus-5-5`, `chatgpt/gpt-6.2-sol`, `codex-plan/gpt-6.2-sol`, then the APIs. A
plan at its limit hands over to the next entry at once, so to the next plan while there is one.

- **Which models a plan serves** is data on its provider: `harness: { order, serves, plan }`.
  `serves` maps API ids, or a whole provider (`"anthropic/*"`), to the plan's own names (`"*"`: the
  same). `plan` is the plan people know it as ("ChatGPT"), shared by `chatgpt` and `codex-plan`.
- **The order** is the plans' own until the person changes it: Claude Code (10), ChatGPT on the
  server (20), Codex (30), Grok Build (40), Antigravity (50). The person reorders their plans with
  `tiers.harnesses` `{ harnesses: ["codex-plan"] }`, kept on their own tier choice: theirs first,
  the rest after. Their order ranks the plans that serve one model; the tier's model order still
  comes first. `modelChoice.harnesses` lists the app's plans (those a tier's model runs on) in their
  order, each with whether they have it.
- **Which they have** is asked on each turn, of the plugins that keep plans (the `connectedPlans`
  resource): their ChatGPT account, connected; a plan signed in on a computer of theirs that's on,
  or that wakes when asked (a cloud computer), and none while nobody's there. A stale answer costs
  one fast failure: the plan's CLI checks again.
- **A chain that names a plan** (`claude-plan/claude-opus-5-5`, as chains were written before)
  stands for its model on the person's plans only. A chain left with nothing for them is tried as
  written, and the plan's failure says what to do.
- **An app without plans,** and a model list without `harnesses`, run as they did.

`models.check` `{ model: { model: chain, harnesses }, port: "llm" }` answers what a chain would try,
in order: a page prices the first (a plan at $0).

## Connecting plans: one flow

A person connects their plans in one flow, "Connect your plans", wherever it opens from: a plan's
card on Your AI (Connect, or Fix), the address `/accounts?connect=<plan or provider>` (every fix-it
link: the palette's, a chat's note), or a step of the app's welcome. It never asks them to run a
command:

1. **Which plans.** Skipped when the door said.
2. **Where they run,** only when a picked plan runs through an app on a computer and the person has
   none that can run plans: "In the cloud" (recommended: made in a click, by a computer kind's
   `add.quick`), or "On this computer" on a desktop browser, which says up front that it needs one
   line in a terminal, once (the computer program's download isn't signed yet).
3. **One checklist,** each line ticking itself off: the computer readied (`computer.prepare`,
   below); each missing CLI installed, as part of its sign-in; each sign-in in turn (a link to the
   provider's page and a field for its code; for ChatGPT on the server, the account's own steps, the
   `accounts.connect` View); and a short test on each plan (`llm.test`). A sign-in on the server can
   go while the computer wakes.

Every failure ends in one button that fixes it (try again, use a cloud computer, make the computer
yours alone, sign in again), or in one plain sentence. A command shows only when an installer
couldn't run (it failed, or the computer runs Windows): with what it said, and the computer's
Terminal a click away.

The checklist is plain functions (`linesOf`, `nextOf` in `views/web/connect-lines.ts`) over what the
flow's calls answered: never over what a record remembers.

The sign-in stays on the computer, in a folder the computer program keeps for each CLI, apart from
the person's own use of it. The app keeps only whether it's done, and as whom. On their own machine
the CLI opens their browser itself; on a cloud computer it gives a link, and the page it opens gives
a code, which goes back to it. Grok Build signs in with a device code on both: a link, and a code to
confirm on that page; nothing goes back to it.

A plan runs only on its person's own computer, and never on one shared into a space where others'
agents work on it as them: the sign-in would be theirs to reach.

### Readying a computer

`computer.prepare` `{ computer }` gets one of the person's computers ready for plans, and says how
it is now. It checks each time; it never answers from the record:

- shared into a space where others' agents work on it as them, it fails `computer_shared`;
- asleep, it wakes (a cloud computer); a laptop that's off fails `offline`, saying so;
- its program older than the app's release (`downloads`): a cloud computer is put to sleep and woken
  again on a new VM (`computerWake.sleep`), once; a laptop is offered the release, and waited for up
  to two minutes. Still old, it goes on: `program.current` says so;
- then it asks the computer what its CLIs are now (`engineStatus`, kept on it).

```ts
const ready = await runtime.call("computer.prepare", { computer }, { actor: person });
// { computer, online: true, engines: { claude: { installed: false, … } }, program: { version, current: true } }
```

### A missing CLI

On macOS and Linux, a sign-in asked to (`install: true`) installs a CLI that isn't there yet: the
plan's official installer runs in the computer's home, then the sign-in starts. The person never
types it: the flow asks for it whenever the check says the CLI is missing. Done, the answer says
whether the CLI is there now (`installed`), so an installer that failed shows as one. On Windows the
installer can't run here: the flow shows the command, and the computer's Terminal.

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
`npm i -g @openai/codex`, Antigravity's and Grok Build's scripts), never one the caller gives.

### A test, on the plan

`llm.test` `{ model }` makes one short call on a model the person's own plan pays for (a provider
tagged `paid: "subscription"`), to show it answers there. It takes one model, never a list, so
nothing falls to another; its words are fixed; a model the app pays for is refused (`invalid`). A
failure keeps its code: at its limit (`engine_limit`) the plan is still connected, and the flow says
so.

## Your AI

The accounts page (`/accounts`) is Your AI: the sections other front ends add first, then the
accounts it shows itself ("Other accounts"), then the person's own API keys. Computers' front end
adds two sections:

- **Your plans** (`accountSections.plans`, with `plans: true`: the accounts that pay for models,
  such as ChatGPT, are among the plans, not cards of their own). One card per plan the app uses:
  where it runs now and its backup ("Running on MacBook (online), with Cloud computer ready as
  backup"), its limit, and one action: Connect, Fix or Sign out. With the app's tiers, the plans are
  theirs to list (the `planList` resource: `{ query, order }`, `modelChoice.harnesses` and
  `tiers.harnesses`), and the person orders them (Move up, Move down). Without, every plan the app
  has shows.
- **Your computers:** each one's state, the plans it runs, its month (the `computer.cost` View, in
  `month` mode), and its Terminal. A card a cloud computer serves says its hour (`cost`), and "In
  the cloud" its price (`price`).

`computer.plans.welcome` is a step for chat's `welcome` resource: "Which AI plans do you have?",
then the same flow.

```ts
welcome: {
  plans: { title: "Which AI plans do you have?", view: "computer.plans.welcome", order: 15 },
}
```

### Signing out

`computer.engine.logout` (Sign out on that computer, in the plan card's menu on Your AI) runs the
CLI's own sign-out on that computer, in the folder the program keeps for it: `claude auth logout`,
`codex logout`, `grok logout`. Their sign-ins are kept there, so when that fails the folder goes
instead. The person's own sign-in (`~/.claude`, `~/.codex`) is never touched. Antigravity has no
sign-out of its own here (its sign-in may be in the system's keyring): signing it out fails
(`unsupported`), saying to sign out in Antigravity on that computer. A cloud computer wakes to sign
out; a laptop must be on.

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

## Which computer a call runs on

A plan's call runs on the person's computers signed in to it, in one order (`servingOrder`): online
first, then one the app keeps (a cloud computer, which wakes), then the rest; the session's computer
first among its own. So a laptop that's off doesn't come before an asleep cloud computer. Your AI's
cards say which serves a plan now, and which is its backup, by the same order.

## A plan at its limit

A call that fails because the plan reached its limit keeps when, on that computer (its
`engines.<engine>.limited`); the next call there that answers clears it. Meanwhile the model list
moves on, and Your AI says since when.

## What a cloud computer keeps

A cloud computer serves each wake on a new VM, and only its disk lasts. So its work (its terminal,
jobs, the plans' CLIs and its browser) runs in a home on the disk: `HOME` is `<disk>/home`, npm's
global prefix is under it (`NPM_CONFIG_PREFIX=<disk>/home/.npm-global`), and the folders both put
programs in come first on the `PATH`. A CLI installed there, by Sign in or from its terminal, is
there on its next wake, signed in as it was. A person's own computer keeps their own home.

Its program is the pool VM's. A free pool VM takes the app's newer release as a laptop does, when
the app offers it (`offerUpdate` in the pool's `ready`): it updates itself and ends, for its service
to start it again. So a computer woken on it runs the app's release; one awake on an older program
across an update is restarted by `computer.prepare` before a plan is set up there.

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
the program's own adapters speak it for Claude Code, Codex and Grok Build. None of them is shipped
with the program: people install the CLI they use, or Sign in installs it.

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
- Antigravity serves Google's models, by their names; others it runs come once their names are
  checked.
- With one plan, a tier's checker can run on the same maker's models as its builder: plans come
  first, whatever the vendor.
- A plan at its limit is tried first on each call until it resets: it fails in seconds.
- Plans run at their CLI's own effort, whatever the chain says.
- Grok Build reaches an agent's tools through its own search: a tool call takes it a few more model
  turns. Its built-in skills stay in its prompt. Grok keeps a copy of each session at xAI.
- A computer program older than 1.0.0-rc.66 has no Grok Build: Sign in says it doesn't know it until
  it updates.
- On a laptop, a CLI installed where the program doesn't look (npm's prefix under a version manager,
  not on the program's `PATH`) isn't found: the page then shows the command to run by hand.
- A computer program older than 1.0.0-rc.65 neither installs a CLI nor signs one out. The connect
  flow updates the program first (`computer.prepare`); a cloud computer can't be newer than its
  pool's VMs, and when they're older the flow says so.
- On Windows a plan's CLI is installed from the computer's Terminal: the flow shows its command.
- "On this computer" needs one line in its terminal, once: the program's download isn't signed yet.
- A cloud computer awake on an older program when a plan is set up there is restarted: the jobs it
  keeps start again; others stop.
- ChatGPT on the server doesn't show its limit on its card.
- With tiers, the cards follow the app's tiers, not tiers an org saved of its own.
- The estimate takes a plan as it last said: a plan at its limit still shows $0.
- A wake's time is an estimate. Past it, the notice says "Still waking…".
- A tool run on the server for longer than a cloud computer stays warm lets it sleep between steps:
  the next step starts a fresh session, given the whole conversation.
- A CLI removed while its computer is awake still shows as signed in until the computer is asked
  again.
- "This month" is the calendar month in UTC. The disk shows at its monthly price, at the app's disk
  size now.
- "Covers about N hours" counts the plan's credits, not what's left of them.
