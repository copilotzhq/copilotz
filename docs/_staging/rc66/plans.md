# STAGING: rc.66, stream "plans" (not published)

> **Staging, not a page.** What the plans stream adds to `CHANGELOG.md` and `AGENTS.md` at release.
> Not in `docs/manifest.json`. Delete it once merged into those files.

## CHANGELOG entry (under `## 1.0.0-rc.66`)

**New:**

- **Plans first, native first.** A tier names models, and each turn runs them on its person's plans
  first: for each model, in the chain's order, every plan of theirs that serves it, in their order;
  then the APIs, as the chain lists them. Someone with only ChatGPT gets `chatgpt/…sol` before
  Anthropic's API. A plan at its limit hands over to the next plan while there is one. `tiers.model`
  answers `{ model: chain, harnesses }` where the app has plans; an app without them answers as
  before.
- **Which models a plan serves** is data on its provider: `harness: { order, serves, plan }`.
  `serves` maps API ids, or a whole provider (`"anthropic/*"`), to the plan's own names. The default
  order: Claude Code, ChatGPT on the server, Codex, Grok Build, Antigravity. A model list given
  `harnesses` runs on them first (the models plugin); an entry naming a plan (`claude-plan/…`)
  stands for its model on plans only. `models.check` answers what a list would try, in order.
- **A person's order of their plans.** `tiers.harnesses` `{ harnesses }` sets it, kept on their own
  tier choice; `modelChoice.harnesses` lists the app's plans in their order, each with the plan it's
  on and whether they have it. `plansFor(ctx, mine)` is what a turn goes with.
- **Which plans a person has**, asked on each turn: the `connectedPlans` resource, filled by
  `account.connected` (their connected accounts) and `computer.connected` (plans signed in on a
  computer of theirs that's on or wakes; none while nobody's there).
- **Grok Build: `grok-plan`.** A fourth engine, `grok`, on a person's Grok plan: `grok -p` as only
  the engine (the agent's prompt, none of its tools, no memory, subagents, plan mode or web search),
  the session's MCP server alone, its own `HOME` and `GROK_HOME`, never an xAI key. A prompt it
  offers tools of its own fails before the model acts. Sign-in by device code, status by
  `grok models`, its own sign-out, its official installer. It serves xAI's models by their own
  names, at no cost to the app.

**Breaking:**

- **`account.uses` and the word over the composer are gone** ("Runs on your ChatGPT Plus plan").
  They read only the first of an agent's own models. The tiers' composer line says what a chat's
  agents run on, and what it costs.
- **`tiers.model`'s answer** is `{ model, harnesses }` in an app with plans: code that read it as a
  list reads `.model`.

**Known limits:**

- With one plan, a tier's checker can run on the same maker's models as its builder.
- A plan at its limit is tried first on each call until it resets: it fails in seconds.
- Plans run at their CLI's own effort.
- Antigravity serves Google's models; others once their names are checked.
- Grok Build reaches an agent's tools through its own search (a few more model turns), keeps its
  built-in skills in its prompt, and keeps a copy of each session at xAI.
- A computer program older than rc.66 has no Grok Build until it updates.

**Upgrading:** an app with plans whose code reads `tiers.model`'s answer reads `.model`. Chains that
name plans (`claude-plan/…`) keep working; name models instead (`anthropic/…`), and the person's
plans come first by themselves. A page that showed `accounts.uses` shows the tiers' composer line.

## AGENTS.md

Under **Find it → Computers and plans**, after "Share a computer signed in to a plan":

```md
- Run a tier's models on each person's plans first, in their order → `harness` on a provider,
  `tiers.harnesses`, `modelChoice.harnesses`, `connectedPlans` →
  [Plans first](docs/guides/agents-on-peoples-plans.md#plans-first).
- See what a chain would try for someone → `models.check` with `harnesses` →
  [Plans first](docs/guides/agents-on-peoples-plans.md#plans-first).
- Run agents on a person's Grok plan → `grok-plan`, engine `grok` →
  [The providers](docs/guides/agents-on-peoples-plans.md#the-providers).
```

## Find it

- Plans first, the harness catalog, the person's order →
  [Agents on people's own plans: Plans first](docs/guides/agents-on-peoples-plans.md#plans-first);
  the models side → [Models and providers](docs/reference.md#models-and-providers).
- `grok-plan` →
  [Agents on people's own plans: The providers](docs/guides/agents-on-peoples-plans.md#the-providers).
