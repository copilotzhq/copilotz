---
title: "Chapter 28: Agents that schedule"
description: "\"Remind me every Monday\" from a chat: four tools that make, list and cancel routines as the person the agent works for, post back where they were asked, and let an agent name a run's chat for what it found."
section: Getting Started
order: 280
status: stable
---

# Chapter 28: Agents that schedule

> Part 8, skills and routines · Requires: Chapter 27 · Code: `lesson-8.3`

## The pain

You tell North "remind me every Monday at 9 to send the weekly report", and North says "sure".
Nothing happens on Monday. North answers when someone writes to it; between conversations it isn't
there, so it can't remember anything for you. Chapter 27 gave you routines, but only from the
Routines tab or `/every`: the place where you think of one, the chat, can't make one.

## The problem

An agent making a routine must not get a second, looser way to schedule work. The routine it makes
has to be the same routine you'd make: kept by the same Action, checked the same way, and, since a
routine runs as whoever made it, made **as the person the agent works for**, never as the agent. It
should post back where it was asked, so a reminder lands in the conversation it came from. And the
model needs to read what it set up in words, with the id it needs to cancel it later.

## The solution

**Four tools**, chat's `tools` resource kind, as in Chapter 11: `schedule_routine`, `list_routines`
and `cancel_routine`, and `name_chat` for a chat a run started. They are Copilotz's names and
inputs, in `plugins/routines/resources/tools.ts`, and `mod.ts` adds them as a resource:

```ts
resources: {
  tools,
  // A space's routines, and their runs, live in it.
  shared: { routine: {}, routineRun: {} },
},
```

### Offered where you may write

The first three share one `offer`. It's a function of the agent, the thread and a View's context, so
it reads like a View: the `reached` query of spaces (Chapter 7), the spaces you reach and what you
may do in each. Out of a space, or in an archived one, the model never sees these tools:

```ts
/** Where the person an agent works for may write: its own conversation's space. */
const offer = (_agent: string, thread: Thread, ctx: ViewContext) => {
  if (!thread.in || !personOf(ctx.actor)) return false;
  const spaces = ctx.db.collection("space").query<Space[]>("reached", {}).value;
  return !!spaces?.find((s) => s._id === thread.in)?.can?.includes("write");
};
```

`personOf` is Copilotz's: the person an actor is, or works for, followed along `for`. An agent's
turn runs as `{ kind: "agent", id: "north", for: { kind: "person", id: "ana" } }`, so it's `ana`.

### As the person

Every tool starts from the same place: the conversation's space, the person, and a context **acting
as them**:

```ts
async function whereFor(ctx: ToolContext) {
  const person = personOf(ctx.actor);
  const thread = await ctx.db.collection<Thread>("thread").findOne({ _id: ctx.thread });
  if (!person) return { missing: "Routines are a person's, and you aren't working for one here." };
  if (!thread?.in) return { missing: "This conversation isn't in a space: nowhere to keep it." };
  return { person, space: thread.in, as: ctx.as({ kind: "person", id: person }) };
}
```

`ctx.as(actor)` is trusted code's way to act as someone else; what it does is recorded as that
actor. `schedule_routine` calls `routine.create` through it, and the rest is Chapter 27:
`routine.create` sets the timer in the same commit, as its caller, and time runs a timer as whoever
set it. So the routine is yours, and it runs as you, even though North made it:

```ts
run: async (input, ctx) => {
  const where = await whereFor(ctx);
  if ("missing" in where) return where.missing;
  try {
    const made = await where.as.call<{ routine: string }>("routine.create", {
      in: where.space,
      ...(input.name ? { name: input.name } : {}),
      text: input.text,
      agent: input.agent ?? ctx.agent,
      schedule: input.schedule as Given,
      ...(input.post === "new"
        ? { post: "new", ...(typeof input.chat_name === "string" ? { chatName: input.chat_name } : {}) }
        : { post: "same", thread: ctx.thread }),
    });
    // … read it back, and say it in words
  } catch (error) {
    return `Couldn't make it: ${(error as Error).message}`;
  }
},
```

Two defaults do most of the work. The agent it asks is the one calling the tool (`ctx.agent`), and
it posts **back in this chat**: `post: "same"` with `thread: ctx.thread`, the chat it was made from.
A reminder reads as one thread. When each run is its own piece of work (a daily analysis), the model
passes `post: "new"` and a `chat_name`. The tool's description says when to pick which, and to ask
the person's timezone when the time matters; without one, a schedule is in UTC.

A refusal is text, as with the board: `routine.create`'s own words ("Say at what time, as \"09:00\"
(24-hour clock).") come back as "Couldn't make it: …", and the model can ask and try again.

### What the model reads

A routine, for a model, is one line with its id, its schedule in words (`describe`, from Chapter
27's `shared/schedule.ts`), when it runs next, and how it last went:

```ts
/** A routine, as an agent reads it: one line, with its id. */
const line = (r: Routine, maker: string) => {
  const zone = "timezone" in r.schedule ? r.schedule.timezone : "UTC";
  const next = r.next ? `next ${moment(r.next, zone)} ${zone}` : r.paused ? "paused" : "done";
  const last = r.last ? `; last ${r.last.outcome}${r.last.error ? ` (${r.last.error})` : ""}` : "";
  return `- "${r.name}" [${r._id}]: ${describe(r.schedule)}, asks @${r.agent}: "${r.text}" ` +
    `(${next}${last}; made by ${maker})`;
};
```

`list_routines` answers one such line per routine, through the `routine.list` query, read as the
person. `cancel_routine` finds one by its `[id]` or its name and calls `routine.delete`; the chats
it posted in stay.

### A run's chat, named for what it found

A routine that posts in a new chat each run names it from `chatName` ("Prices · 2026-11-02"): fine
in a list, but it says nothing about what the run found. Chapter 27's run starts that chat with
`renamable: true` (chat.send takes it for a new thread), and chat's `thread` keeps it: "an agent
working here may name it". `name_chat` is offered only there:

```ts
const nameChat = tool({
  // Only in a chat a routine's run started, for its agent to name.
  offer: (_agent, thread, ctx) => !!thread.renamable && !!personOf(ctx.actor),
  // …
  run: async ({ name }, ctx) => {
    const where = await whereFor(ctx);
    if ("missing" in where) return where.missing;
    const title = String(name).replace(/\s+/g, " ").trim().slice(0, 120);
    if (!title) return "A name says something.";
    await where.as.db.collection("thread").updateOne({ _id: ctx.thread }, { $set: { title } });
    return `Named it "${title}".`;
  },
});
```

### On the web

`routinesWeb` gets a View for `schedule_routine`'s calls (chat's `toolViews`, as the board's
`board.step`): "Set up Monday report", the name a link to the routine's page, read from the `[id]`
in what the tool said:

```ts
export const routineStepView = (call: ShownCall, ctx: ViewContext<ReactNode>): ReactNode => {
  if (ctx.hints.running === true) {
    return (
      <span>
        <Spinner size={14} /> Setting up a routine…
      </span>
    );
  }
  const path = madePath(call.output);
  const name = String(call.input?.name ?? "") || "a routine";
  return (
    <span>
      <Icon name="refresh" size={14} /> {path
        ? (
          <>
            Set up <a href={path}>{name}</a>
          </>
        )
        : call.output}
    </span>
  );
};
```

### Telling North

The charter gets a paragraph beside the board's and the skills':

```text
**Routines** (`schedule_routine`, `list_routines`, `cancel_routine`), for whatever should happen on
a schedule ("every Monday…", "remind me at 9"): you won't remember between conversations; a
routine will. Ask the person's timezone when the time matters, and say what you set up and where
it posts.
```

## Run it

Offline, North's model only echoes, so it won't call a tool; but `/prompt` shows what it's offered,
and the charter it reads:

```sh
printf 'Hi North\n/prompt\n' | COMPASS_ME=ana COMPASS_DATA=.data/try.sqlite OPENAI_API_KEY= \
  node --disable-warning=ExperimentalWarning terminal.ts
```

```text
Compass
Ana → north › Hi North
north › You said: Ana: Hi North
ana › /prompt
── tools · north
list_boards, read_board, create_board, create_card, update_card, move_card,
read_skill, schedule_routine, list_routines, cancel_routine
── system (cached across turns)
…
**Routines** (`schedule_routine`, `list_routines`, `cancel_routine`), for
whatever should happen on
a schedule ("every Monday…", "remind me at 9"): you won't remember between
conversations; a
routine will. Ask the person's timezone when the time matters, and say what you
set up and where
it posts.
…
```

(The terminal wraps the prompt at 80 columns, on top of the charter's own lines.) Three routine
tools, and no `name_chat`: this chat wasn't started by a run.

With a key, ask North in a space: "remind me every Monday at 9 to send the weekly report". The tests
run that conversation with a scripted model instead (`tests/tools.test.ts`); here is what the tools
told it, with the manual clock moved to Monday 9:00 in São Paulo between the first and the second
call:

```text
Made it: "Monday report" [a58a4aaf-…]: Mondays at 9:00 AM (Sao Paulo time), asks @north: "Remind me
to send the weekly report" (next Mon, Nov 9, 9:00 AM America/Sao_Paulo; made by Ana). Each run posts
in this chat. It runs as Ana; they can pause, change or delete it in this space's Routines.

ana: Remind me to send the weekly report
north: north: Ana (via routine "Monday report"): Remind me to send the weekly report

- "Monday report" [a58a4aaf-…]: Mondays at 9:00 AM (Sao Paulo time), asks @north: "Remind me to send
the weekly report" (next Mon, Nov 9, 9:00 AM America/Sao_Paulo; last sent; made by Ana)

Deleted "Monday report". The chats it posted in stay.
```

The reminder came back in the chat it was asked in, as Ana, marked as the routine's. (`next` is
worked out from the real clock, not the test's: the routine's own record, for a person to read.)

## Check it

`tests/tools.test.ts`: in a space, North is offered the three routine tools and not `name_chat`;
`schedule_routine` makes a routine as Ana, posting in that chat; time comes, and the reminder lands
there; `list_routines` lists it, a schedule with no time is refused in words, and `cancel_routine`
deletes it by name. A second test runs a routine whose message asks its agent to call `name_chat`,
and checks the run's new chat took the name. `tests/web.test.ts` draws `routine.step` with a link to
the routine's page. And `tests/parity.test.ts` now runs the same conversation on Copilotz's routines
and on yours, and compares what each tool said. One sentence is left out of the comparison:
Copilotz's `schedule_routine` also says how to allow ahead of time what a run needs a yes for (a
computer's command, say); Compass has no computers to ask one.

## Also in this chapter

- `plugins/routines/mod.ts`: its doc comment says what agents get from a conversation.
- `plugins/routines/web.tsx`: `routine.step` and the `toolViews` resource for `schedule_routine`.
- `plugins/compass/resources/charter.ts`: its doc comment says the charter covers skills and
  routines too.

`git diff lesson-8.2 lesson-8.3` shows every change.

## What you have now

Agents that keep time for you: "remind me every Monday" in a chat becomes a routine, yours, that
runs as you and answers back in that chat. North knows what it can read (skills) and what it can set
going (routines), each through the same Actions you use.

Next, Part 9 gives agents the web: a search tool that asks an adapter port, and reading a page
safely.
