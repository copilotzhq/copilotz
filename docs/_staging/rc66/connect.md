# STAGING: rc.66, the connect stream (not published)

> **Staging, not a page.** What the connect stream adds to `CHANGELOG.md` and `AGENTS.md` at the
> release, merged with the other streams' entries. It's not in `docs/manifest.json`. Delete it once
> it's merged.

## CHANGELOG entry

For the release's summary paragraph: a person connects their plans in one flow, with no terminal and
a button for every failure, from Your AI (which replaces Connected accounts), a fix-it link, or the
app's welcome.

**New:**

- **One connect flow.** "Connect your plans" opens from a plan's card on Your AI (Connect, Fix), the
  address `/accounts?connect=<plan or provider>` (every fix-it link) and a step of the app's
  welcome, which picks several at once. It asks where the plans run only when one runs through an
  app on a computer and the person has none that can: in the cloud (made in a click by a computer
  kind's `add.quick`), or on this computer (on a desktop browser, saying it needs one line in a
  terminal, once). Then one checklist: the computer readied, then one line per plan, one at a time,
  through its phases: its CLI installed as it signs in, signed in, and a test answered on it. Every
  failure ends in Try again (a laptop that's off also offers a cloud computer); a command shows only
  when an installer failed or can't run (Windows), with its output and the computer's Terminal a
  click away.
- **`computer.prepare`** `{ computer }` readies one of the person's computers for plans, checking
  each time: woken (a cloud computer), its program brought to the app's release (a cloud computer is
  restarted on a new VM, through `computerWake`'s new `sleep`; a laptop is offered the release and
  waited for), then what its CLIs are now. It fails `computer_shared` or `offline`, saying why.
- **`engineStatus`** asks a computer what its plans' CLIs are now, and keeps it on the computer,
  field by field. Every check uses it; a sign-in that's done says whether its CLI is there
  (`installed`).
- **`llm.test`** `{ model }` tries one model the person's own plan pays for (a provider tagged
  `paid: "subscription"`), to show it answers there. It never spends the app's key.
- **Your AI.** The accounts page is Your AI: other front ends' sections first, then "Other
  accounts", then the person's own API keys. A section with `plans: true` shows the accounts that
  pay for models among the plans. Computers' front end adds Your plans (a card per plan the app
  uses, where it runs now and its backup, its limit, one action; the person's order, from the tiers'
  `planList`) and Your computers (state, the plans each runs, its month, its Terminal).
  `accounts.connect` is a plan on the server's line in the flow: a button that opens its dialog. The
  page's frame and connect dialog are in Brazilian Portuguese too.
- **The welcome's step.** `computer.plans.welcome`, for chat's `welcome` resource: "Which AI plans
  do you have?", then the flow.
- **A plan at its limit** is kept on the computer (`engines.<engine>.limited`) until a call there
  answers; Your AI says since when.
- **Pool VMs update themselves.** A free pool VM says what it is (`POOL.info`) and takes the app's
  newer release (`POOL.update`), as a laptop does, then ends for its service to start it again. An
  app offers it with `offerUpdate(ctx, POOL_KIND, vm)` in its pool's `ready`.

**Fixed:**

- **A laptop that's off came before an asleep cloud computer.** A plan's call went to the signed-in
  computer seen last once none was online, so a closed laptop made the call fail to the API instead
  of waking the cloud computer. One order now (`servingOrder`): online, then those the app keeps,
  then the rest.

**Changed:**

- `?signin=<engine>` is gone: `?connect=<plan or provider>` opens the flow.
- The sign-in dialog, its per-computer rows and the always-shown install command are gone: the flow
  replaces them.
- Messages that said "Connected accounts" say "Your AI".

**Known limits:**

- On Windows a plan's CLI is installed from the computer's Terminal: the flow shows its command.
- "On this computer" needs one line in its terminal, once: the program's download isn't signed yet.
- A cloud computer awake on an older program when a plan is set up there is restarted: the jobs it
  keeps start again; others stop.
- A computer that can't be brought to the app's program is used as it is.
- A computer shared with others' agents doesn't run plans: Your AI shows such a plan as not
  connected, and Connect sets it up on another computer, or a cloud one.
- The flow connects a plan's first way in: ChatGPT through Codex isn't offered beside ChatGPT on the
  server.
- The flow signs a plan in on the person's best computer: a second one, a backup, is one they've
  signed in on before.
- A test of a model the plan doesn't include shows as a failure, in the provider's words.
- ChatGPT on the server doesn't show its limit on its card.
- With tiers, the cards follow the app's tiers, not tiers an org saved of its own.

## AGENTS.md

In "Find it", under **Computers and plans**, after "Install a missing plan CLI, then sign in":

```markdown
- Connect a person's plans without a terminal → the connect flow, `/accounts?connect=<plan>` →
  [Connecting plans: one flow](docs/guides/agents-on-peoples-plans.md#connecting-plans-one-flow).
- Ready a computer for plans (woken, updated, checked) → `computer.prepare` →
  [Readying a computer](docs/guides/agents-on-peoples-plans.md#readying-a-computer).
- Check that a person's plan answers → `llm.test` →
  [A test, on the plan](docs/guides/agents-on-peoples-plans.md#a-test-on-the-plan).
- Show a person's plans and computers → Your AI, `accountSections` (`plans: true`), `planList` →
  [Your AI](docs/guides/agents-on-peoples-plans.md#your-ai).
- Ask about plans in the app's welcome → `computer.plans.welcome` →
  [Your AI](docs/guides/agents-on-peoples-plans.md#your-ai).
- Keep cloud computers on the app's release → `offerUpdate` (a pool's `ready`) →
  [What a cloud computer keeps](docs/guides/agents-on-peoples-plans.md#what-a-cloud-computer-keeps).
```

No other AGENTS.md text changes.
