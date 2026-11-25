---
title: "Agents on people's own plans"
description: "An agent's model calls can run on the plan of the person it works for (Claude, ChatGPT, Google AI through Antigravity, Grok), through the plan's CLI on a computer of theirs: the providers, plans first and in the person's order, signing in once (installing a missing CLI), signing out, what a cloud computer keeps, and what runs where."
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

## Signing in, once

A person signs a plan in from Connected accounts (`computer.engines` lists their computers and the
CLIs each has; `computer.engine.login` runs a CLI's own sign-in there):

- **On their own machine,** the CLI opens their browser, and that's all.
- **On a cloud computer,** it shows a link; the page it opens shows a code, which goes back to it.
- **Grok Build** signs in with a device code on both: a link, and a code to confirm on that page.
  Nothing goes back to it.

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
`npm i -g @openai/codex`, Antigravity's and Grok Build's scripts), never one the caller gives.

### Signing out

`computer.engine.logout` (Sign out, in the menu of a computer's line on the plan) runs the CLI's own
sign-out on that computer, in the folder the program keeps for it: `claude auth logout`,
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
the program's own adapters speak it for Claude Code, Codex and Grok Build. None of them is shipped
with the program: people install the CLI they use, or Sign in installs it.

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
- A computer program older than 1.0.0-rc.65 neither installs a CLI nor signs one out: Sign in says
  it's missing, and Sign out fails, until it updates.
