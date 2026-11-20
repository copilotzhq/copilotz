---
title: "Agents on people's own plans"
description: "An agent's model calls can run on the plan of the person it works for (Claude, ChatGPT through Codex, Google AI through Antigravity), through the plan's CLI on a computer of theirs: the providers, signing in once, and what runs where."
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
program: people install the CLI they use.
