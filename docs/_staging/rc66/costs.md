# rc.66 staging: costs (an honest cost display, and the small reliability pieces)

Not a page. What the release commit takes from the `rc66/costs` branch: the CHANGELOG entry, the
AGENTS.md text and where it goes, and the "Find it" lines. Built on `rc66/plans` (`plansFor`,
`models.check`'s list) and `rc66/connect` (`engineComputer`'s order, `engineStatus`).

After integrating, run `deno run -A scripts/describe.ts --docs`: the reference pages of chat
(`live.waking`), computers (`computer.cost`, the View, the resource kinds it reads), models (the
`waking` chunk) and tiers change. They were already stale on main (rc.64's version), so it rewrites
them all.

## CHANGELOG

Under **New:**

- **What a message costs you.** Tiers price a typical message for the person looking, at the first
  model their turn would try, plans first. On one of their plans a kind of work costs them nothing
  (`ModelShown.plan`), and a tier says what it comes to for them (`TierShown.yours`). The composer
  reads "Everyday · on your plans · model $0", or "Everyday · 2¢" with no plan connected. `price`
  stays what it costs on the app's models: the org's and a space's pages, which choose for others,
  show it.
- **What a cloud computer costs.** `computer.cost` (`{ computer? }`, for people) says what one of
  theirs the app keeps costs them, or a new one:
  - an hour awake;
  - how long it stays awake after;
  - its disk a month;
  - how far the plan's credits go after a month's disk;
  - this month so far, from the usage ledger.

  The `computer.cost` View says it in a line, by mode (`price`, `cost`, `month`). The app gives the
  prices: `computerWake.prices` names its query (`ComputerPrices`), and nothing is priced in
  Copilotz.
- **Waking, said.** A plan's call that wakes a computer says so first: a `waking` model chunk, with
  the app's estimate (`computerWake.estimate`: `{ seconds, slower? }`). Chat shows "Waking the
  computer… (about 5 seconds)", or that it takes longer at this hour, then "Still waking the
  computer…" past it.

Under **Changed:**

- **Check, don't remember.** Once a plan's call has woken a computer, it asks what the plan's CLI is
  now, and keeps it. One that isn't signed in any more is passed over for the next computer at once.
- **A running step is use.** A plan's step touches its computer every minute while it runs, and once
  more when it ends, so the app's idle check never puts it to sleep mid-step.
- **Plans' words.** Connected accounts says "Your plan pays for the AI.", and where the app keeps
  computers, "A cloud computer you use for it is charged while it's awake.", in place of "Nothing is
  charged here for those calls."
- **Model chunks.** `LlmChunk` has `waking`. `generate` passes it on without counting it as written,
  so a call that fails after it still hands over.

## AGENTS.md

In "Find it", under **Computers and plans**, after the last line there:

```markdown
- Price a tier at what the person would run → `TierShown.yours`, `ModelShown.plan` →
  [What a plan costs](docs/guides/agents-on-peoples-plans.md#what-a-plan-costs).
- Show what a cloud computer costs → `computer.cost`, `computerWake.prices` →
  [What a plan costs](docs/guides/agents-on-peoples-plans.md#what-a-plan-costs).
- Say a plan's computer is waking, and how long → `computerWake.estimate`, the `waking` chunk →
  [Waking a computer](docs/guides/agents-on-peoples-plans.md#waking-a-computer).
```

## Find it (the docs' own lines)

- `computer.cost` → [What a plan costs](../../guides/agents-on-peoples-plans.md#what-a-plan-costs)
- `computerWake.prices`, `ComputerPrices` →
  [What a plan costs](../../guides/agents-on-peoples-plans.md#what-a-plan-costs)
- `computerWake.estimate`, `WakeEstimate`, `{ type: "waking" }` →
  [Waking a computer](../../guides/agents-on-peoples-plans.md#waking-a-computer)
- `TierShown.yours`, `ModelShown.plan` →
  [What a plan costs](../../guides/agents-on-peoples-plans.md#what-a-plan-costs)
- `Live.waking` → [Waking a computer](../../guides/agents-on-peoples-plans.md#waking-a-computer)
