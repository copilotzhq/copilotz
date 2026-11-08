---
title: "Chapter 26: Skills"
description: "Rebuild Copilotz's skills plugin for one person: know-how an agent reads only when a task calls for it, listed by name in the cached part of its prompt and read with one tool."
section: Getting Started
order: 260
status: stable
---

# Chapter 26: Skills

> Part 8, skills and routines · Requires: Chapter 25 · Code: `lesson-8.1`

## The pain

You've explained to North, three chats in a row, how you like a plan written: an outcome on each
task, what "done" looks like, nothing invented. Put it in North's instructions and every turn pays
for it, plans or not; leave it out and you explain it again next week.

## The problem

Know-how has to be there when a task calls for it and cost almost nothing when it doesn't. An agent
can't read what it doesn't know exists, so it must always know which know-how it has; but the
know-how itself should come only when it's needed. Some of it ships with the app's code; some you
write, for one space. And whatever an agent is told every turn must not change from one turn to the
next, or the prompt cache is lost.

## The solution

A **skill** is what a `SKILL.md` file says: a name (`weekly-report`), when it's for, then
instructions, with files it may read besides (a template, a reference). Copilotz's `skills` plugin
keeps them, and it builds only on chat's extension points: a `context` that lists them, and a tool
that reads one. Here is its contract, to keep:

- the `skills` resource: the app's skills, declared in code, plain objects;
- the `skill` collection (a space's own skills, their names, what they're for, their files' sizes)
  and `skillFile` (their text, one document each), with the queries `skill.list`, `skill.read` and
  `skill.files`;
- `skill.create`, `skill.update` and `skill.delete`;
- the `skills` context, in the system part of the prompt, and the `read_skill` tool.

What only a shared app needs stays out: in Copilotz, a space's managers change its skills and
everyone else only uses them; here every space is yours. On the web, reading a pasted or uploaded
`SKILL.md`, changing a skill in place and the command palette's entries stay out too (the Actions
are all here).

```text
plugins/skills/
  mod.ts  contract.ts  web.tsx  terminal.ts
  collections/skill.ts  collections/skill-file.ts
  actions/create.ts  update.ts  delete.ts
  shared/skills.ts  shared/check.ts  shared/write.ts
  resources/tools.ts  resources/commands.ts
  views/context.ts  views/terminal/skills.ts  views/web/…
```

### Two sources, one list

An app declares skills as a resource: a description and instructions, and maybe files, by path. You
make a space's own with the Actions. `shared/skills.ts` says both the same way (`Shown`), and works
out which skills an agent has in a conversation: the app's and its space's, sorted by name, the
app's winning a name both have, and only those an agent names in its definition
(`skills: ["planning"]`), when it names some.

```ts
/** A `skills` resource: know-how an agent reads only when it needs it. */
export type Skill = {
  /** When it's for: what agents see beside its name, to decide whether to read it. */
  description: string;
  /** What to do, in Markdown: what reading it gives them. */
  instructions: string;
  /** Files it may read besides, by path: references, templates, scripts. */
  files?: Record<string, string>;
};

// …

/** The app's skills and a space's, by name, as `agent` may use them; the app's win a name. */
function merged(ctx: { resources: Resources }, agent: string, space: SkillDoc[]): Shown[] {
  const allowed = (agentsOf(ctx)[agent] as { skills?: string[] } | undefined)?.skills;
  const app = Object.entries(appSkills(ctx)).map(([name, s]) => shownApp(name, s));
  const taken = new Set(app.map((s) => s.name));
  return [...app, ...space.filter((doc) => !taken.has(doc.name)).map(shownSpace)]
    .filter((s) => !allowed || allowed.includes(s.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}
```

### In the prompt: names, not instructions

The `skills` context (`views/context.ts`) is one line per skill, its name and what it's for. The
plugin puts it in the system part of the prompt (`context: { skills: { place: "system" } }`), the
part that's cached across turns: sorted by name, it changes only when a skill does.

```ts
const GUIDE = "Skills you have: know-how you read only when a task needs it. When a task " +
  "matches one, read it with read_skill before you start, then follow it; read its files " +
  "when it says to.";

/** One line per skill: its name and what it's for. */
export const skillsContext = (thread: Thread, ctx: ViewContext<string>) => {
  const listed = skillsShown(ctx, ctx.viewer?.name ?? "", thread);
  if (!listed?.length) return undefined;
  return [GUIDE, ...listed.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, " ").trim()}`)]
    .join("\n");
};
```

A context's View gets the conversation, and `ctx.viewer` is the agent the prompt is for: two agents
in one chat can have different skills.

### Reading one, when it's needed

`read_skill` (`resources/tools.ts`) is offered wherever the agent has a skill, and gives back its
instructions, or one of its files:

```ts
const readSkill = tool({
  offer: (agent, thread, ctx) => !!skillsShown(ctx, agent, thread)?.length,
  description: "Read one of your skills (listed under Skills in your instructions): what to do, " +
    "step by step, for the kind of task it's for. Read it before such a task, then follow it. " +
    "With file, read one of the files it lists (a template, a reference).",
  input: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, description: "The skill's name, as listed." },
      file: { type: "string", description: "One of its files, by the path it lists." },
    },
    required: ["name"],
  },
  run: async ({ name, file }, ctx) => {
    const listed = await skillsFor(ctx, ctx.agent, ctx.thread);
    const found = listed.find((s) => s.name === name.trim());
    if (!found) {
      return `No skill "${name}" here.` +
        (listed.length ? ` Yours: ${listed.map((s) => s.name).join(", ")}.` : "");
    }
    // … its instructions (SKILL.md), or the file asked for
  },
});
```

What it reads goes into the conversation like any tool's answer: the next turns still have it, and
the cached prompt before it never changed.

### A space's own skills

`skill.create` (`actions/create.ts`) checks what's written (`shared/check.ts`: a name is lowercase
words joined by dashes, as `SKILL.md` files name theirs; a file's path stays inside the skill),
refuses a name the app's skills or another of the space's have, and writes the skill and its texts
in one transaction:

```ts
run: async (ctx, input) => {
  const files = input.files ?? [];
  const name = input.name.trim();
  checked({ ...input, name, files });
  await free(ctx, input.in, name);
  const skill = crypto.randomUUID();
  await ctx.transaction(async (tx) => {
    await tx.db.collection("skill").insertOne({
      _id: skill,
      in: input.in,
      name,
      description: input.description.trim(),
      size: input.instructions.length,
      files: listed(files),
      // … by, at
    });
    await tx.db.collection("skillFile").insertMany([
      fileDoc(skill, input.in, SKILL_MD, input.instructions),
      ...files.map((f) => fileDoc(skill, input.in, f.path, f.text)),
    ]);
  }).catch(said);
  return { skill, name };
},
```

The `skill` document is small (a name, a purpose, sizes), so the prompt's list reads only that; the
text is in `skillFile`, read only when `read_skill` asks. Both are `shared`, so spaces' rule keeps
them in an active space.

### The plugin

```ts
export const skills: Plugin = definePlugin({
  name: "skills",
  requires: ["chat"],
  collections: { skill, skillFile },
  actions: {
    "skill.create": createAction,
    "skill.update": updateAction,
    "skill.delete": deleteAction,
  },
  views: { "context:skills": skillsContext },
  resources: {
    // In the stable system text: the skills an agent has, by name.
    context: { skills: { place: "system" } },
    tools,
    // A space's skills live in it: in an active space only.
    shared: { skill: {}, skillFile: {} },
  },
  guard: (_actor, { collection, access, direct }) => {
    // … skill and skillFile change only through the Actions
  },
  // The app's skills are what a SKILL.md could say: a mistake stops the runtime from starting.
  check(merged) {
    // … each declared skill's name, description, instructions and files
  },
});
```

`check` runs once, on the merged resources, before the runtime starts: a skill declared with a name
like `Bad Name` stops the app with
`Skill "Bad Name": A name is lowercase letters and digits, words
joined by dashes: weekly-report.`,
instead of an agent finding out mid-conversation.

### Compass's skill

Compass declares one, as Compass itself does: Copilotz's `planning`, imported from
`copilotz/plugins/agents` (`plugins/compass/mod.ts`):

```ts
import { planning } from "copilotz/plugins/agents";
// …
  resources: {
    // … agents, context
    // Know-how the team reads only when a task calls for it (the skills plugin lists it).
    skills: { planning },
  },
```

And the charter says when to read one:

```text
**Skills.** When a task matches one of your skills, read it first (`read_skill`) and follow it.
```

`app.ts` puts `skills` after the plugins it needs and before `compass`, which declares the skill:
`[models, chat, identity, spaces, boards, skills, compass, settingsPlugin(settings)]`.

## Run it

Offline, North's fake model only repeats what it's told, so it won't read a skill; but the terminal
shows what it has, and `/prompt` where it's told:

```text
ana › /skills
planning (the app's)
  Plan work so others can act on it: turn a goal into projects, milestones and
tasks with clear outcomes, evidence and scope. Use it when asked to plan, break
down, organize or track a piece of work.
ana › /prompt
── tools · north
list_boards, read_board, create_board, create_card, update_card, move_card,
read_skill
── system (cached across turns)
# North
…
**Skills.** When a task matches one of your skills, read it first (`read_skill`)
 and follow it.
…
<context name="skills">
Skills you have: know-how you read only when a task needs it. When a task
matches one, read it with read_skill before you start, then follow it; read its
files when it says to.
- planning: Plan work so others can act on it: turn a goal into projects,
milestones and tasks with clear outcomes, evidence and scope. Use it when asked
to plan, break down, organize or track a piece of work.
</context>
── history (cached as it grows)
…
```

`/skill planning` prints its instructions, the text `read_skill` gives North. In the browser, a
space's Settings has a Skills section: Compass's `planning`, the space's own, and a form for a new
one. With a key, ask North to plan the launch, and the chat shows "Read the planning skill" before
its answer.

## Check it

`tests/skills.test.ts`: a space's skills change through their Actions, never with a name the app's
has; an agent's prompt lists its skills by name and `read_skill` reads one, or one of its files,
with a scripted model calling it; an agent that names its skills sees only those; Compass's team has
`planning`; and a skill declared wrong stops the app. `tests/parity.test.ts` runs the same scenario
on Copilotz's skills (on Copilotz's identity and spaces) and on yours: the Actions' answers and
refusals, the three queries, what `read_skill` tells the agent and the list in its prompt.

## Also in this chapter

- `actions/update.ts` and `actions/delete.ts`: a skill's name, purpose, instructions and files
  (`files` is the whole set it keeps), in one commit; deleted with its texts.
- `collections/skill.ts`: the queries front ends read, `skill.list` (the app's, then the space's),
  `skill.read` (a skill and its instructions or a file; the app's are `app:<name>`) and
  `skill.files`.
- `web.tsx`: `skillsWeb`, a Skills tab under a space's Settings (spaces' `spaceTabs`,
  `under:
  "settings"`), a page at `/skill/<id>`, and a line in chat for each `read_skill` (chat's
  `toolViews`, `skill.step`). `front.ts` adds it.
- `terminal.ts`: `skillsTerminal`, `/skills` and `/skill <name>`. `terminal.ts` at the root adds it.

`git diff lesson-7.3 lesson-8.1` shows every change.

## What you have now

Agents that know what they know, and read it only when a task calls for it: the app's skills from
code, a space's from you, one cached line each in the prompt. Next, time becomes a caller: routines
that send an agent a message on a schedule.
