---
title: "Chapter 8: A chat on your site"
description: "Anyone who opens the salon's site can chat with the concierge: their first message makes them a customer, with a chat of their own, and a panel beside it books into that chat."
section: Getting Started
order: 80
status: stable
---

# Chapter 8: A chat on your site

> Part 2, the ways in · Requires: Chapter 7 · Code: `chapter-8`

## The pain

The salon's own site should take bookings too, from anyone, without an account. A chat widget from a
vendor knows nothing of your bookings, and a form knows nothing of the chat. Wiring both to your
backend means a public API, with its own idea of who may do what.

## The problem

A visitor is a stranger. Their first message should make them a customer, with a chat of their own,
answered by the concierge. Beside the chat they should be able to book by hand. Both should reach
their own bookings and nothing else, and the desk should see them with everyone else's.

## The solution

Copilotz's site chats, and a page of the salon's own for visitors.

### The site's chat

`app.ts` adds `webLines`, the web interface's site chats, and declares one:

```ts
// The site's chat: a visitor is a contact, in a chat of its own at the desk.
web: { site: { in: DESK, agent: "concierge", title: "Site visitor" } },
```

A page that comes in by this site (`POST /web/site`) becomes a **visitor**, kept in a cookie.
Nothing else is made yet. Its first message, `chat.send` naming no chat, makes it a contact with a
chat of its own at the desk, titled "Site visitor", answered by the concierge. From then on it
reaches that chat and nothing else, like an assistant's conversation in chapter 5.

### A page for visitors

Copilotz's web shell is built for people who work in spaces, and doesn't draw a visitor's page yet.
So the salon draws its own: `plugins/site/web.tsx`, a View named `web.shell`, the one the web host
draws for the page. Before the first message, a field to write it. From then on, the visitor's chat
beside the bookings panel:

```tsx
// A visitor's chat, from their first message on: the one shared with them.
const mine = ctx.db.collection<Member>("member").find({ member: ctx.viewer?.name ?? "" }).value;
const chat = mine?.find((m) => m.on === "thread")?.space.replace(/^thread:/, "");
return (
  <main className="visit">
    <style href="salon-site" precedence="copilotz">{STYLE}</style>
    <h1>The salon</h1>
    {chat
      ? (
        <div className="visit-chat">
          {ctx.show("site.chat", { _id: chat })}
          {ctx.show("bookings.panel", { _id: chat })}
        </div>
      )
      : (
        <section className="visit-talk">
          <p>Ask for a time. The concierge answers, and you can book beside the chat.</p>
          <Say send={(text) => ctx.call("chat.send", { text })} />
        </section>
      )}
  </main>
);
```

A visitor finds their chat by their membership of it: a chat shared with a contact alone is theirs
`on: "thread"`. The View reads it, so the page redraws the moment the first message makes the chat.

`site.chat` is the conversation, read as the visitor. The rules keep the agent's private steps (its
tool calls) out of what they read:

```tsx
const chatView = (chat: { _id: string }, ctx: Ctx): ReactNode => {
  const me = ctx.viewer?.name;
  const said = ctx.db.collection<Message>("message")
    .find({ thread: chat._id }, { sort: { at: -1 }, limit: 100 }).value ?? [];
  const working = (ctx.db.collection("live").find({ thread: chat._id }).value ?? []).length > 0;
  return (
    <section className="visit-talk" aria-label="Your chat">
      {said.toReversed().filter((m) => m.text && !m.private).map((m) => (
        <p key={m._id} className={m.from === me ? "mine" : ""}>{m.text}</p>
      ))}
      {working ? <p aria-live="polite">…</p> : null}
      <Say send={(text) => ctx.call("chat.send", { thread: chat._id, text })} />
    </section>
  );
};
```

`Say` is a field and a Send button, made with Copilotz's `Input` and `Button`. A generic visitor
page may come to Copilotz later. Then this file shrinks to what's the salon's.

### The panel

The panel is bookings' View once more, in `web.tsx`. Booked here, a slot goes in the visitor's chat:

```tsx
// A customer on the site: beside their chat. Booked here, it's in that chat.
"bookings.panel": (chat: { _id: string }, ctx: Ctx) =>
  salon(ctx, "Your bookings", { thread: chat._id }),
```

### One page, two front ends

`front.ts` gets a second list, the site's: the web shell, bookings' front end, and the site's own
`web.shell` last, so it's the one drawn:

```ts
// The site's own `web.shell` comes after the web shell's, so it's the one drawn.
export const site: Plugin[] = [webShell, bookingsWeb, siteWeb];
```

`browser.tsx` picks by address. The site is the root, and comes in as a visitor. Staff work
everywhere else:

```tsx
const root = document.getElementById("app")!;
if (location.pathname === "/") await web({ root, plugins: site, arrive: { name: "site" } });
else await web({ root, plugins: front, start: async () => ({ space: "desk" }) });
```

### Tests, as a browser

`tests/ways.ts` gets its second way in: `visitor(runtime, address)`. It comes in by the site, keeps
its cookie, and becomes a client with Copilotz's `connect`, as the page's host does.
`tests/site.test.ts` sends a first message, books from the panel, and draws the page as the visitor
sees it:

```ts
// The page, as the visitor's browser draws it: their chat, beside their bookings.
const page = site.observe<ReactNode>("web.shell", { path: "/" }, { viewer: site.viewer });
const shown = await page.ready;
page.close();
assert.equal(shown.status, "ready");
const html = renderToStaticMarkup(shown.status === "ready" ? shown.value : null);
assert.match(html, /<p class="mine">Hi, what&#x27;s free\?<\/p>/);
assert.match(html, /Tuesday 11:00 and Thursday 9:00 are free\./);
assert.match(html, /Tue 11:00, for Site visitor/);
assert.doesNotMatch(html, /for Bia/, "Bia's booking isn't the visitor's to see");
```

It also tries to write a booking straight from the browser, and the guard from chapter 2 refuses it.
The payoff test gains a fourth way in, and its rules test a visitor calling `booking.cancel` on
Bia's booking. The tour gains a visitor too.

## Run it

`npm run dev`, then open http://127.0.0.1:8080/ in a browser where nobody is signed in. With a key,
a visitor's page, after two messages and a press of Book beside Fri 14:00:

```text
The salon

Hi! Is Friday afternoon free?

Yes—Friday at 2:00 PM is free. Would you like me to book it?

I booked Friday at 2 beside the chat. Can you also book Saturday at 10?

Booked Saturday at 10:00. Your bookings are Friday at 2:00 PM and Saturday at 10:00 AM.

Send
Your bookings
Fri 14:00, for Site visitor Cancel
Sat 10:00, for Site visitor Cancel
Free
Tue 10:00 Book
Tue 11:00 Book
Wed 15:00 Book
Thu 09:00 Book
```

The concierge saw the booking made from the panel: they share a chat. One browser is one visitor, so
open the desk in another browser, or a private window, and sign in there as `sam`. In this one, the
desk's page would say "You can't see this here" everywhere: a visitor isn't staff.

And `npm test`:

```text
✔ a visitor chats, books from the panel beside the chat, and sees only theirs (129.764458ms)
```

## What this unlocks

- **Your site, open to anyone.** No accounts, and still every visitor reaches only their own
  bookings.
- **Chat and buttons on the same booking.** The agent and the panel act in the same chat, so each
  sees what the other did.
- **The same View, a third time.** The desk's tab, the assistant's widget and the site's panel are
  one View.

## Your challenge

Give the site a way to start over: a "New chat" button that sends a message naming no chat. Which
bookings does the panel show then, and why?

Next, WhatsApp.
