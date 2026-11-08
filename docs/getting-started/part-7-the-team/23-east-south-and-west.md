---
title: "Chapter 23: East, South and West"
description: "North gets a team: three more of the app's own agents, each with its own way of working and its own model alias, in every space, with the charter in each one's prompt."
section: Getting Started
order: 230
status: stable
---

# Chapter 23: East, South and West

> Part 7, the team · Requires: Chapter 22 · Code: `lesson-7.1`

## The pain

North does everything: it decides, it drafts, it checks its own claims, and it untangles the hard
questions. One agent that leads is also the one agent that agrees with itself. When you want
something built to see if it works, or a claim checked before the plan rests on it, there's nobody
else to ask.

## The problem

A team isn't four copies of North. Each member needs its own job, its own way of working and its own
way of leaning when two values pull apart, while sharing the same values and the same way of talking
with you. And the rest of the app has to know them: every space must seat them, chat must know who
answers a new chat, and you must be able to address any of them.

## The solution

### Three more agents

An agent is an entry of chat's `agents` resource: its name, an icon, a description others read, its
instructions, and a model. `resources/agents.ts` adds East, South and West beside North, with
Compass's own instructions, trimmed of what this app doesn't have yet (a computer to run things on):

```ts
/** The team's agents, by name: the charter goes to them. */
export const TEAM = ["north", "east", "south", "west"];

// … north

export const east: Agent = {
  name: "East",
  icon: "🌅",
  description: "Ask East when building it is the fastest way to know, when a bold idea " +
    "deserves its strongest version before anyone judges it, or when a limit everyone " +
    "treats as fixed needs pushing on. East checks back only when results change the goal.",
  model: "east",
  default: true,
  instructions: `# East

You make things real. When an idea is in question, you build the smallest real version of it and
let the result decide. Smallest means less scope, not a weaker idea: keep the bold part and cut
what's around it. The calls inside the work are yours. Work by the team's charter, which
follows.

## How you work
1. Say in one line what the build should show: the question it answers.
2. Build the smallest version that answers it for real: the hard part working, not faked. There's
   no computer here to run things on: build what you can in the conversation (a draft, a
   calculation, a mockup) and say what you couldn't run.
// …`,
};
```

South finds out: it takes a claim to real contact and says how far it held. West finds the one
question a tangled decision turns on, and recommends. Each one's **close calls** say which way it
leans when two values pull apart: East builds rather than debates (Agency over Knowledge), South
stops the work to check what the plan rests on (Truth over Agency), West won't blend two sides to
keep everyone happy (Truth over Love).

The plugin hands them to chat in `mod.ts`, and the charter goes to all four, since `TEAM` lists
them:

```ts
resources: {
  agents: { north, east, south, west },
  context: {
    // The values and how the team talks: beside the agents' own instructions, cached with them.
    compass: { place: "system", agents: TEAM, instructions: true },
    // …
  },
},
```

The charter gets one paragraph for a team that leans different ways:

```text
## When values pull against each other

Every agent holds all six values, fully; your close calls say which way you lean when two pull
apart, not what you care about more (each names the two, for you). When you lean, say the
trade-off in plain words, never by a value's name (people don't know them), so they can push back:
"I went ahead because it's easy to undo."
```

### A model alias each

Each agent names a model alias of its own name, and the app says what each alias is (`app.ts`):

```ts
const thinks = settings.openai ? { model: "openai/gpt-6-luna", effort: "low" } : "fake/echo";
// …
    model: {
      // What the team thinks with: the model alias each agent names, its own name.
      north: thinks,
      east: thinks,
      south: thinks,
      west: thinks,
      // …
    },
```

Today they all think with the same model. Tomorrow South can think longer, or West run on another
provider, by changing one line in the app, not the agent.

### In every space

All four say `default: true`. In Copilotz's spaces, that's what makes an app agent join every new
space; your spaces already seat every app agent, and still pick the first default, North, to answer
a space's new chats. What changed is the order `space.roster` lists them in. Copilotz's lists the
app's defaults first, then the rest, each group by name; yours listed the answering agent first.
With one agent nobody could tell; with four, the parity test against Copilotz's spaces does. So
`actions/roster.ts` now orders them as Copilotz does, and says who answers separately:

```ts
const declared = (ctx.resources.agents ?? {}) as Record<string, { default?: boolean }>;
const agents = agentsIn(ctx).sort((a, b) =>
  Number(!declared[a].default) - Number(!declared[b].default) || a.localeCompare(b)
);
const answers = agentsIn(ctx, space.agent)[0];
return { agents, ...(answers ? { default: answers } : {}) };
```

A message with no mention still goes to North. `@east` or `@south` in it goes to them instead: chat
takes an `@word` as a mention only when it names someone (an agent, or a person in the
conversation), and two names reach both, who take their turns in parallel.

## Run it

```text
Compass
Ana → east, south › @east @south What would you each check first?
east › You said: Ana: @east @south What would you each check first?
south › You said: Ana: @east @south What would you each check first?
ana › /prompt south
── tools · south
list_boards, read_board, create_board, create_card, update_card, move_card, list_documents,
read_document, write_document, append_document, edit_document, remember, recall, forget
── system (cached across turns)
# South

You find out. You take claims to real contact (work it through, measure it, read the source) and
report what actually held. Anything is yours to test: what East built, West's reasoning, North's
…
You are South, called south, in a conversation.
Other agents here: East, called east (Ask East when building it is the fastest way to know, when a
bold idea deserves its strongest version before anyone judges it, or when a limit everyone treats as
 fixed needs pushing on. East checks back only when results change the goal.).
People here: Ana.
…
```

Offline, the fake model only repeats what it heard, but who answers is real: East and South, both,
and not North. `/prompt south` shows South's own instructions first, then the charter, and who else
is in the conversation, with East's description.

## Check it

`plugins/compass/tests/team.test.ts`: every space's roster lists the four, in Copilotz's order, with
North answering its new chats (`space.roster`, and `thread.agents`, which front ends ask); each
one's prompt is its own instructions, then the charter; and a message naming `@east @south` goes to
both, and both answer.

## Also in this chapter

- `plugins/spaces/tests/spaces.test.ts`: the roster test uses the team instead of a test agent of
  its own, and expects Copilotz's order.
- `plugins/spaces/tests/parity.test.ts`: Copilotz's spaces now lists all four.
- `plugins/compass/resources/charter.ts` and `mod.ts`: their doc comments.

`git diff lesson-6.4 lesson-7.1` shows every change.

## What you have now

A team of four in every space, each with its own job and model, sharing one charter. You can address
any of them. Next, North learns to bring them in itself, two at once.
