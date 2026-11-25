# rc.65 staging: cloud-home

A cloud computer keeps what's installed in its home across sleep; Sign in installs a missing plan
CLI; a plan signs out on one computer; a cloud computer signed in to a plan isn't shared with
others' agents.

## (a) CHANGELOG entry

Under `## Unreleased`:

```markdown
A cloud computer keeps what's installed in its home, so a plan's CLI is still there after it sleeps.
Sign in installs a missing CLI, and a plan signs out on one computer.

**New:**

- **A cloud computer keeps what's installed in its home.** In pool mode, a computer's work (its
  terminal, jobs, the plans' CLIs and its browser) runs with `HOME` on its own disk (`<disk>/home`),
  npm's global prefix under it (`NPM_CONFIG_PREFIX`), and both their programs' folders first on the
  `PATH`. Claude Code from its installer, Codex from `npm i -g`, and anything else installed there
  is there on its next wake, on a new VM, signed in as it was. A person's own computer keeps their
  own home. An existing cloud computer gets its home at its next wake.
- **Sign in installs a missing CLI.** On macOS and Linux, a computer whose plan CLI is missing
  offers "Install Claude Code and sign in", on the plan's card and in the sign-in dialog. The dialog
  says what it runs there, and the click is the consent. `computer.engine.login` with
  `install: true` runs the plan's official installer (the app's own command, never the caller's) in
  the computer's home, then the sign-in. An installer that fails shows what it said last and the
  command to run by hand. Windows keeps the instructions.
- **A plan signs out on one computer.** `computer.engine.logout`, from the menu of the computer's
  line on the plan. Claude Code and Codex run their own sign-out in the folder the computer program
  keeps for them (the folder goes when that fails), never touching the person's own `~/.claude` or
  `~/.codex`. Antigravity can't be signed out from here (`unsupported`): its sign-in may be in the
  system's keyring. A cloud computer wakes for it; a laptop must be on.

**Changed:**

- **A cloud computer signed in to a plan isn't shared with others' agents.** `computer.share` and
  `computer.move` refuse it a desk where agents answer to whoever they work for, outside a Personal
  space, while it last said it's signed in to a plan (`plan_signed_in`). Its person signs out of it
  first; the share dialog says so, with a link to the plans. A person's own computer may still be
  shared, and the dialog says what that means: the space's agents can read everything on it, its
  owner's own sign-ins included. A computer shared with others' agents still runs nobody's plan.
- A shared computer's line in the sign-in dialog says "Your plan runs on your own computer. This
  shared one runs your agents' tools."
- New words, in English and Brazilian Portuguese: `computers.installAndSignIn`, `installRuns`,
  `stepInstall`, `installFailedTitle`, `installFailedText`, `signOut`, `signOutFailed`,
  `shareSignedIn` and `shareOwnWarning`. `computers.rowSharedSomewhere` says the line above.
- A computer program older than this neither installs a CLI nor signs one out: Sign in says the CLI
  is missing, and Sign out fails, until it updates.
```

## (b) AGENTS.md

A new group in "Find it: what an app needs, and where it's documented", after **Files, exports and
paper**:

```markdown
**Computers and plans**

- Keep a cloud computer's installed CLIs across sleep → `startPool` (its home: `<disk>/home`) →
  [What a cloud computer keeps](docs/guides/agents-on-peoples-plans.md#what-a-cloud-computer-keeps).
- Install a missing plan CLI, then sign in → `computer.engine.login` (`install: true`) →
  [A missing CLI](docs/guides/agents-on-peoples-plans.md#a-missing-cli).
- Sign a plan out on one computer → `computer.engine.logout` →
  [Signing out](docs/guides/agents-on-peoples-plans.md#signing-out).
- Share a computer signed in to a plan → `computer.share` (`plan_signed_in`) →
  [Signing out](docs/guides/agents-on-peoples-plans.md#signing-out).
```

## (c) Find it lines

- Keep a cloud computer's installed CLIs across sleep → `startPool` (`<disk>/home`) →
  `docs/guides/agents-on-peoples-plans.md#what-a-cloud-computer-keeps`
- Install a missing plan CLI, then sign in → `computer.engine.login` `{ install: true }` →
  `docs/guides/agents-on-peoples-plans.md#a-missing-cli`
- Sign a plan out on one computer → `computer.engine.logout` →
  `docs/guides/agents-on-peoples-plans.md#signing-out`
- Share a computer signed in to a plan → `computer.share` (`plan_signed_in`) →
  `docs/guides/agents-on-peoples-plans.md#signing-out`

## Known limits (in the guide)

- A shared computer is shared whole: agents in its spaces can read everything on it, sign-ins kept
  there included. Keep personal sign-ins on a computer you don't share.
- Antigravity can't be signed out from here: its sign-in may be in the system's keyring.
- On a laptop, a CLI installed where the program doesn't look (npm's prefix under a version manager,
  not on the program's `PATH`) isn't found: the page then shows the command to run by hand.
- A computer program older than 1.0.0-rc.65 neither installs a CLI nor signs one out.
