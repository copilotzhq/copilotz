---
title: "Chapter 24: Asking in parallel"
description: "North brings teammates in with chat's send_message: questions that don't depend on each other go out in one step, the teammates work at the same time, and North resumes once, with every reply."
section: Build Compass
order: 240
status: stable
---

# Chapter 24: Asking in parallel

> Part 7, the team · Requires: Chapter 23 · Code: `lesson-7.2`

## The pain

You have a team now, but you're the one who runs it. To hear East and South on Friday's launch, you
write to East, wait, write to South, wait, and then carry both answers back to North yourself.

## The problem

North should bring them in itself, and only when their view would change the call. When its
questions don't depend on each other, asking one after the other wastes time: East's draft doesn't
need South's check. North needs to ask both at once, wait for both, and only then decide, with both
answers in front of it. And all of it should happen in the conversation, where you can see who was
asked what.

## The solution

### One tool, from chat

Nothing to build: `send_message` is chat's own tool. Unlike the board's tools, which say where
they're offered (`offer`), it goes only to an agent that lists it in its `tools`. All four list it
(`resources/agents.ts`):

```ts
/** Chat's tools each of them lists: asking a teammate (or you) for something. */
const tools = ["send_message"];

export const north: Agent = {
  name: "North",
  icon: "🧭",
  description: "Ask North to set the goal, make a decision, or settle a disagreement " +
    "between agents. North brings in others only when their view would change the call.",
  model: "north",
  tools,
  default: true,
  // …
};
```

Chat describes the tool to each agent with the others in the conversation's space, by their
descriptions (that's what they're for), and says how it works: unless `expectReply` is false, the
agent's turn pauses once that step's tools have run, and resumes when every message it sent in that
step has a reply. Send several in one step, and they go out together; the teammates take their turns
in parallel. A message goes in the conversation itself by default (`in: "thread"`), where you see
it, or in a subthread or a new thread.

### When and how to ask

North's instructions say when (`resources/agents.ts`):

```text
2. Answer yourself when you can. Bring in East (build it), South (test it) or West (untangle it)
   only when their view would change the call; ask at once when their questions don't depend on
   each other.
3. When teammates disagree, don't blend them: choose, say why, and say what would change your
   mind. When someone pushes back without a new fact, keep the call, kindly; when they bring
   one, move, and say which fact moved you.
```

and, under what it doesn't do, "Paste a teammate's reply as your answer. You own the call: say what
you take from it." The charter says how, for all four (`resources/charter.ts`):

```text
**Asking another agent.** `send_message` asks one teammate (North, East, South, West, or any
other agent in this space) for one bounded contribution, visibly in the conversation.
- Send questions that don't depend on each other in the same step: teammates work in parallel,
  and you resume once every reply is in. Ask in turn only when a question needs an earlier answer.
- Make each message stand alone: the goal, the context, what you need back, and the decision it
  feeds. Don't narrate the mechanics.
- Keep views independent: ask before you've said what you think. Weigh replies by their evidence,
  not by how many agree or how sure they sound, and change your view only for a new fact or
  argument, saying which.
- Other tool calls keep the turn with you. When your work is finished, reply normally.
```

"Ask before you've said what you think" matters more than it looks: a teammate that reads North's
opinion first tends to agree with it, and then two replies are worth one.

### Seeing it without a key

A real model decides when to ask. To see the mechanics offline, the test plays all four on a
scripted model (`plugins/compass/tests/asking.test.ts`), patching the four aliases to it:

```ts
if (agent === "east") return yield { type: "text", text: "A one-page draft is ready." };
if (agent === "south") return yield { type: "text", text: "Checkout works in 3 of 3 tries." };
if (turn === 0) {
  // Both questions in one step: neither depends on the other.
  for (const [to, said] of [["east", "Draft the launch page."], ["south", "Check checkout."]]) {
    yield {
      type: "tool_call",
      call: { id: `ask-${to}`, name: "send_message", input: { to, text: said } },
    };
  }
  return;
}
const replies = messages.slice(-2).map(text).join(" | ");
yield { type: "text", text: `We launch Friday. (${replies})` };
```

North's first call asks both; its second, once both have replied, sees the two replies last and
answers from them.

## Run it

The test's second half runs the same scripted team through the terminal host (Copilotz's
`terminal()`, as `terminal.ts` does), and this is what it prints with `SHOW=1`:

```text
Ana → north › Can we launch on Friday?
  ⚙ north: send_message → Sent to east; you'll have the reply bef…; send_message → Sent to south;
you'll have the reply be…
north → east › Draft the launch page.
north → south › Check checkout.
east → north › A one-page draft is ready.
south → north › Checkout works in 3 of 3 tries.
north › We launch Friday. (east: A one-page draft is ready. | south: Checkout works in 3 of 3
tries.)
```

With a key, `npm run terminal` and ask something two teammates could answer apart: "Can we launch on
Friday? Ask East for the page and South to check checkout." Offline, the fake model answers itself,
but `/prompt` shows North now has the tool:

```text
ana › /prompt
── tools · north
list_boards, read_board, create_board, create_card, update_card, move_card, list_documents,
read_document, write_document, append_document, edit_document, remember, recall, forget,
send_message
```

## Check it

`plugins/compass/tests/asking.test.ts`: North is offered `send_message`, which lists East, South and
West by their descriptions; East's and South's turns overlap in time; North's model is called
exactly twice, to ask and to answer; the conversation holds the question, both asks, both replies
and North's answer, in that order; and the terminal shows all of them.

## Also in this chapter

- East, South and West list `send_message` too: any of them may ask a teammate, or you.
- North's "What you don't do" also says to look a disputed fact up, or ask South to check it.
- `plugins/compass/resources/agents.ts` and `charter.ts`: their doc comments.

`git diff lesson-7.1 lesson-7.2` shows every change.

## What you have now

A team that works together: North brings in who it needs, at once when it can, and decides with
every answer in front of it, in the open. Next, the team reads the space's other conversations
instead of asking you to repeat yourself.
