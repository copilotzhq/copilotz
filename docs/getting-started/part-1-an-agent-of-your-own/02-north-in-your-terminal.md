---
title: "Chapter 2: North, in your terminal"
description: "Move North into a plugin of your own, laid out by primitive; give the team a charter as a View in North's prompt; talk to North in Copilotz's terminal and see exactly what it's sent."
section: Getting Started
order: 20
status: stable
---

# Chapter 2: North, in your terminal

> Part 1, an agent of your own · Requires: Chapter 1 · Code: `lesson-1.2`

## The pain

In `hello.ts`, North is one line of instructions inside the script that runs it. Every other way to
reach North (a terminal, a web page, a test) would have to define it again, and the copies drift.
And you can't see what North is actually told: the model gets more than your instructions, and
you're guessing at the rest.

## The problem

North belongs to the product, not to one script: defined once, run anywhere. What every agent of the
team shares (how they work, what they value) should be written once too, beside North's own
instructions. And you need to see the exact prompt, the way the model gets it.

## The solution

### A plugin of your own

Compass's own code is a plugin, `compass`, laid out the way Copilotz's plugins are: one folder, one
file per declaration, by primitive.

```text
plugins/compass/
  mod.ts                 assembles the plugin, and nothing else
  resources/agents.ts    North, the chat plugin's `agents` resource
  resources/charter.ts   what the team holds in common
  views/charter.ts       the charter, as North's prompt shows it
  tests/compass.test.ts
```

As the plugin grows it gets `collections/`, `actions/`, `processors/`, `views/` for each place,
`routes/`, `shared/` (only for what several files use) and `contract.ts`: what other plugins may
import from it. Plugins never import each other's code; they talk through the runtime, by name.

North is a resource of chat's `agents` kind (`resources/agents.ts`):

```ts
import type { Agent } from "copilotz/plugins/agents";

/** The team's agents, by name. */
export const TEAM = ["north"];

export const north: Agent = {
  name: "North",
  icon: "🧭",
  description: "Ask North to set the goal, make a decision, or settle a disagreement.",
  model: "north",
  default: true,
  instructions: `# North

You lead this team, and people come to you first. Your job: understand what they're trying to
achieve and carry the work to a clear decision: what we'll do, who does it, what happens next.
…`,
};
```

Two details matter. `default: true` makes North join every new conversation. And `model: "north"` is
an **alias**, not a model: which model North thinks with is the app's choice, set where the app
reads its settings, so changing it never touches the plugin.

### A context, whose content is a View

The charter is what every agent of the team shares: six values, and how they talk with people. Chat
lets other plugins add to an agent's prompt with **contexts**. A `context` resource says where the
text goes; the text itself is a **View** named `context:<name>`:

```ts
// plugins/compass/views/charter.ts
import { CHARTER } from "../resources/charter.ts";

export const charterView = (): string => CHARTER;
```

```ts
// plugins/compass/mod.ts
import { definePlugin, type Plugin } from "copilotz";
import { north, TEAM } from "./resources/agents.ts";
import { charterView } from "./views/charter.ts";

export const compass: Plugin = definePlugin({
  name: "compass",
  requires: ["chat"],
  views: {
    "context:compass": charterView,
  },
  resources: {
    agents: { north },
    context: {
      // The values and how the team talks: beside the agents' own instructions, cached with them.
      compass: { place: "system", agents: TEAM, instructions: true },
    },
  },
});
```

`instructions: true` says the charter is the app's own words on how its agents work, so chat sends
it as it is, right after the agent's instructions. Any other context is information, not
instructions: chat wraps it in a `<context name="…">` tag and puts it after who's in the
conversation (Chapter 4 shows one).

A View is how data presents itself in one place. An `llm` View returns text for the model; later
chapters add Views for the web (React) and the terminal (Ink) to the same plugins. `requires` says
compass builds on chat: the runtime refuses to start without it.

### The app, in one list

`app.ts` lists every plugin Compass runs, in order, and ends with the app's own settings as
resources. Nothing in it reads the environment: whoever runs the app (the terminal, the server, a
test) passes the settings in.

```ts
import { definePlugin, type Plugin } from "copilotz";
import { models } from "copilotz/plugins/models";
import { chat } from "copilotz/plugins/agents";
import { compass } from "./plugins/compass/mod.ts";

export type Settings = {
  /** OpenAI's API key; without it, agents answer with the offline fake model. */
  openai?: string;
};

/** The app's settings for the plugins before it: a later plugin patches an earlier one's resources. */
function settingsPlugin(settings: Settings): Plugin {
  return definePlugin({
    name: "compass-settings",
    resources: {
      provider: settings.openai ? { openai: { apiKey: settings.openai } } : {},
      // What North thinks with: the `north` model alias its agent names.
      model: {
        north: settings.openai ? { model: "openai/gpt-6-luna", effort: "low" } : "fake/echo",
      },
    },
  });
}

/** Every plugin Compass runs, in order. */
export function plugins(settings: Settings = {}): Plugin[] {
  return [models, chat, compass, settingsPlugin(settings)];
}
```

Chat checks every agent's model when the runtime starts, asking the models plugin: a missing
provider or an effort the model doesn't take stops `createRuntime`, not North's first answer.

### The terminal

Copilotz has a terminal host: a command line over a runtime, drawn with Ink. What it shows comes
from plugins: the terminal's data (`terminalPlugin`), its shell (`terminalShell`, the root View) and
each feature's terminal front end (`chatTerminal`: conversations, and commands such as `/prompt`).
Create `terminal.ts`:

```ts
import process from "node:process";
import { userInfo } from "node:os";
import { createRuntime } from "copilotz";
import { memoryStore } from "copilotz/stores/memory";
import { chatTerminal } from "copilotz/plugins/agents/terminal";
import { terminalPlugin } from "copilotz/plugins/interfaces";
import { terminalShell } from "copilotz/plugins/interfaces/terminal";
import { terminal } from "copilotz/terminal";
import { plugins } from "./app.ts";

// Who you are here: your user name on this machine.
const me = process.env.COMPASS_ME || userInfo().username;

const runtime = await createRuntime({
  store: memoryStore(),
  plugins: [
    ...plugins({ openai: process.env.OPENAI_API_KEY }),
    terminalPlugin,
    terminalShell,
    chatTerminal,
  ],
});
await terminal({ runtime, me, banner: "Compass" });
await runtime.close();
```

The front ends are added here, not in `app.ts`: only the process that draws loads them.

## Run it

```sh
node --env-file-if-exists=.env terminal.ts
```

Talk to North, then type `/prompt`. You type as your user name on this machine; the transcripts in
this guide set `COMPASS_ME=ana`:

```text
ana → north › Hi North. In one line: who are you?
north › I'm North, the team lead who helps turn questions into clear decisions and next steps.
ana › /prompt
── tools · north
(none)
── system (cached across turns)
# North

You lead this team, and people come to you first. …

# The team's charter
…
You are North, called north, in a conversation.
People here: ana.
── history (cached as it grows)
user      ana: Hi North. In one line: who are you?
assistant I'm North, the team lead who helps turn questions into clear decisions and next steps.
── turn (what's new, then kept in the history)
(nothing new)
```

## The prompt is a View

`/prompt` shows exactly what North would be sent now. It isn't a log of a past call: it renders
chat's `llm.thread` View, the same function that builds every model call, for this conversation and
this agent. (`runtime.query("thread.prompt", { thread, agent })` returns it in code.) It has four
parts, in the order providers cache them:

- **tools**: what North may call. None yet.
- **system**: North's instructions, then the charter (a context with `instructions: true`), then
  who's in the conversation, which chat adds itself, then any other `system` contexts. It stays the
  same from turn to turn, so the provider's prompt cache keeps it.
- **history**: the conversation, each message through its own View. It only grows at its end, so the
  cache keeps it too.
- **turn**: `turn` contexts that say something new. Chapter 4 puts one there.

Because the prompt is a View, a plugin changes how anything reads to a model by adding Views, the
same way it changes how anything looks on a screen.

## Check it

A test runs the app with no key and reads North's prompt (`plugins/compass/tests/compass.test.ts`):

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntime } from "copilotz";
import { memoryStore } from "copilotz/stores/memory";
import { plugins } from "../../../app.ts";

test("North answers a new chat, with the charter in its prompt's system part", async () => {
  const runtime = await createRuntime({ store: memoryStore(), plugins: plugins() });
  try {
    const { thread } = await runtime.call<{ thread: string }>("chat.send", { text: "Hi" });
    await runtime.idle();
    const { system } = await runtime.query<{ system: string[] }>("thread.prompt", {
      thread,
      agent: "north",
    });
    // North's own instructions, then the charter (the `compass` context), then who's here.
    assert.match(system[0], /^# North/);
    assert.match(system[1], /^# The team's charter/);
  } finally {
    await runtime.close();
  }
});
```

```sh
node --test "plugins/*/tests/*.test.ts"
```

## Also in this chapter

- `package.json`: the `terminal` and `test` scripts.

`git diff lesson-1.1 lesson-1.2` shows every change.

## What you have now

North lives in a plugin, defined once; the charter reaches its prompt through a View; and you can
see the exact prompt any time. Next, Compass gets a web page, and with it the question every web app
has to answer first: who is this request?
