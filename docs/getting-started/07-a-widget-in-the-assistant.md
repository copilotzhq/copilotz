---
title: "Chapter 7: A widget in the assistant"
description: "The desk's Bookings View, drawn inside ChatGPT and Claude under the tool's answer, with what it reads answered ahead as the conversation's contact. Its buttons are the same Actions, and only the widget may press them."
section: Getting Started
order: 70
status: stable
---

# Chapter 7: A widget in the assistant

> Part 2, the ways in · Requires: Chapter 6 · Code: `chapter-7`

## The pain

A list of slots as prose is a poor way to book. ChatGPT and Claude can draw a small app under a
tool's answer, but building one usually means a second frontend: its own calls, its own idea of who
the user is, and its own copy of the booking screen.

## The problem

You already have a booking screen: the desk's Bookings View. The assistant should draw that one, as
the conversation's customer sees it, with its buttons calling the same Actions. And the model must
not be able to press those buttons itself: they're the person's.

## The solution

A widget plugin, a page to draw it in, and a few words in the MCP server's settings.

### The View, a third time

The widget is a View of bookings' web front end, next to the desk's tab (`web.tsx`). Its item is the
tool's call, and its chat is the conversation's:

```tsx
/** In an assistant: the tool's call is the item, and its chat is the conversation's. */
export const bookingsWidget: Plugin = definePlugin({
  name: "bookings-widget",
  views: {
    "bookings.widget": (_call: unknown, ctx: Ctx) =>
      salon(ctx, "Your bookings", { thread: ctx.hints.thread as string }),
  },
});
```

It's the same `salon()` as the desk's: the same two named queries, the same buttons. A booking made
from it goes in the conversation's chat.

### The page it's drawn in

`widget.tsx` is the widget's code, for the assistant's sandbox:

```tsx
await widget({ plugins: [bookingsWidget], root: document.getElementById("app")! });
```

`server.ts` bundles it into one file and hands it to the app as `widgets`, a new setting:

```ts
// What an assistant draws under a tool's answer: the same View as the web's.
widgets: widgetsOf({
  code: () => bundle(new URL("./widget.tsx", import.meta.url), { split: false }),
  plugins: [bookingsWidget],
}),
```

### Which tools draw it

The MCP server's settings say which tools come with the widget, and which Actions its buttons call:

```ts
tools: {
  list_slots: { annotations: { readOnly: true } },
  book: { widget: "bookings.widget", invoking: "Booking…", invoked: "Booked." },
  my_bookings: { annotations: { readOnly: true }, widget: "bookings.widget" },
  cancel_booking: {},
  // What the widget's buttons do: the same Actions, never the model's to call.
  book_slot: { action: "booking.make", title: "Book a slot" },
  cancel_slot: { action: "booking.cancel", title: "Cancel a booking" },
},
```

- **`widget`** draws the View under that tool's answer. `invoking` and `invoked` are what ChatGPT
  shows while it runs and after.
- **`{ action }` entries** are tools only the widget may call. Each comes with a grant for this
  conversation: without it, or with another conversation's, the call is refused.

### Answered ahead

A widget can't wait for a round trip before it draws. So the tool's answer carries, beside the text
the model reads, what the widget needs: the View, the call, and **what the View reads, already
answered, as the conversation's contact**. That's why the View reads in its own body, through named
queries, since chapter 3. A read inside a component would never reach the answer.

Nothing is pushed to a widget afterwards. It shows what came with the answer, and after a button it
reads again, through the server's `copilotz_read`, as the same contact.

The server draws the widget's View ahead, on Node, so it loads `web.tsx`: that's what `tsx.ts` was
for.

### Tests

`tests/mcp.test.ts` books from one conversation and checks what came with the answer:

```ts
// What the View reads, answered already: only this conversation's booking.
const value = (query: string) => widget.reads.find(([key]) => key.includes(query))![1].value;
assert.deepEqual((value("reached") as { label: string }[]).map((b) => b.label), ["Wed 15:00"]);
```

Then it presses Book, with and without the grant:

```ts
// Its Book button: the same Action, as the contact, with the widget's grant.
const pressed = await one.call(widget.tools["booking.make"], {
  slot: "thu-09",
  thread: widget.hints.thread,
  _grant: widget.grant,
});
assert.equal(pressed.text, "Done in the widget.");
```

```ts
// Without the grant, the model can't press it.
const forged = await one.call(widget.tools["booking.make"], {
  slot: "tue-11",
  thread: widget.hints.thread,
});
assert.ok(forged.failed);
```

The payoff test from chapter 6 gains a step: the widget's Book button, for Thu 09:00, "for
Assistant" on the desk's tab, `contact by mcp` in the record. Its rules test presses the widget's
Cancel on Bia's booking, with a real grant, and is refused.

## Run it

With `npm run dev`, `tools/list` now says which tools draw a widget, and which only the widget may
call (each tool's `_meta`, shortened):

```text
book {"openai/toolInvocation/invoking": "Booking…", "openai/toolInvocation/invoked": "Booked.", "ui": {"visibility": ["model", "app"], "resourceUri": "ui://salon/widget-d0b39dc8903c.html"}, "openai/outputTemplate": "ui://salon/widget-d0b39dc8903c.html", ...}
book_slot {"ui": {"visibility": ["app"]}, "openai/widgetAccessible": true, "openai/visibility": "private", ...}
copilotz_read {"ui": {"visibility": ["app"]}, "openai/widgetAccessible": true, "openai/visibility": "private", ...}
```

And `book` answers with the text the model reads, and, apart from it, the widget's snapshot:

```text
{
 "view": "bookings.widget",
 "hints": {
  "thread": "mcp-1517b62fda12a6bf81e7ea53b192e0d1"
 },
 "viewer": {
  "kind": "contact",
  "name": "contact:c-4e058c80d2e49690a9280da0"
 },
 "grant": "g2.c-4e058c80d2e49690a9280da0.to89oa.d82d8a7b2e83f8ca94b32f1dbce5c5ae",
 "tools": {
  "booking.make": "book_slot",
  "booking.cancel": "cancel_slot"
 },
 "read": "copilotz_read"
}
```

(`item` and `reads`, the call and the two queries' answers, are left out here.) And `npm test`:

```text
✔ the widget: its template, and what it reads, answered as the conversation's contact (114.080333ms)
```

This chapter's widget is checked through the protocol, offline. It hasn't been drawn in a real
ChatGPT or Claude host yet.

## What this unlocks

- **Your screen, inside the assistant.** The desk's View, drawn for the customer, under the answer
  that booked it.
- **Buttons that are still Actions.** Same rules, same record, and a grant keeps the model's hands
  off them.
- **Nothing new to keep in sync.** One View, three places: the desk, the site (chapter 8), the
  assistant.

## Your challenge

Give `cancel_booking` the widget too, then test that the snapshot after a cancel no longer reads the
cancelled booking.

Next, the salon's own site gets a chat.
