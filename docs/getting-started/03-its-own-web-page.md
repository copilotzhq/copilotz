---
title: "Chapter 3: Its own web page"
description: "The desk on the web: Copilotz's web shell with a Bookings tab, drawn by a React View that reads two named queries, as the reader, live. Its buttons are the same Actions."
section: Getting Started
order: 30
status: stable
---

# Chapter 3: Its own web page

> Part 2, the ways in · Requires: Chapter 2 · Code: `chapter-3`

## The pain

Staff need a screen. The usual way: an endpoint per screen, a frontend that repeats what the server
knows ("is this slot free?"), and a timer that polls for changes. Then the rules from chapter 2 have
a second home in the frontend, and they drift.

## The problem

The page should read what its reader may read, as that reader, and nothing else. It should follow
the data as it changes, wherever the change came from. Its buttons should be the same Actions as
everyone else's. And one more thing: the browser can't read `slot_taken` at all, since that
collection has no rule.

## The solution

Two named queries, and a View for the web.

### Named queries

A **named query** belongs to a collection and runs on the server, as whoever asks. The rules have
filtered what it reads, and it can read what the browser can't (`queries.ts`):

```ts
/** The bookings the reader reaches, in the salon's order, each with whom it's for. */
export const reached: QueryDef<Booking> = {
  allow: peopleOrContacts,
  run: async (bookings, _params, ctx): Promise<Reached[]> => {
    const order = Object.keys(slotsOf(ctx));
    const found = (await bookings.find({}) as Booking[])
      .toSorted((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot));
    const chats = ctx.db.collection<{ title?: string }>("thread");
    return await Promise.all(found.map(async (b) => ({
      ...b,
      for: b.name ?? (b.thread && (await chats.findOne({ _id: b.thread }))?.title) ?? "a walk-in",
    })));
  },
};

/** The free slots: which are gone is all a customer learns, never whose they are. */
export const open: QueryDef<{ _id: string }> = {
  allow: peopleOrContacts,
  run: async (taken, _params, ctx): Promise<Free[]> => {
    const gone = new Set((await taken.find({})).map((t) => t._id));
    return Object.entries(slotsOf(ctx))
      .filter(([slot]) => !gone.has(slot))
      .map(([slot, label]) => ({ slot, label }));
  },
};
```

`mod.ts` registers them on their collections (`queries: { reached }`, `queries: { open }`), so
they're `booking.reached` and `slot_taken.open`. The text Views from chapter 2 now read them too:

```ts
export const reached = (ctx: ViewContext<unknown>): Reached[] =>
  ctx.db.collection("booking").query<Reached[]>("reached", {}).value ?? [];
export const free = (ctx: ViewContext<unknown>): Free[] =>
  ctx.db.collection("slot_taken").query<Free[]>("open", {}).value ?? [];
```

One read, for every medium. Chapter 7 draws the same reads inside ChatGPT, and changes nothing here.

### A View for the web

`plugins/bookings/web.tsx` is bookings' web front end. `Salon` is a plain React component: two
lists, with a Book or Cancel button on each line. The View reads, and hands it what it read:

```tsx
const salon = (ctx: Ctx, title: string, where: { thread?: string } = {}) => (
  <Salon
    title={title}
    bookings={ctx.db.collection("booking").query<Reached[]>("reached", {}).value ?? []}
    free={ctx.db.collection("slot_taken").query<Free[]>("open", {}).value ?? []}
    book={(slot) => ctx.call("booking.make", { slot, ...where })}
    cancel={(booking) => ctx.call("booking.cancel", { booking })}
  />
);

export const bookingsWeb: Plugin = definePlugin({
  name: "bookings-web",
  requires: ["web-shell"],
  views: {
    // A space's Bookings tab: every booking there. Booked here, it's a walk-in, where the page
    // is: the call is in its space.
    "bookings.tab": (_space: unknown, ctx: Ctx) => salon(ctx, "Bookings"),
  },
  resources: {
    spaceTabs: { bookings: { title: "Bookings", view: "bookings.tab", order: 15 } },
  },
});
```

- **The View reads in its own body**, never inside a component. What it reads there is what it's
  observed by: when a commit changes the answer, the runtime runs the View again, and the page
  redraws. No polling, no refresh button.
- **The buttons are the Actions.** `ctx.call` calls `booking.make` as the person at the page, under
  the same rules as anyone, and where the page is. Copilotz's web host says each page's space: on
  `/space/desk`, every call is at the desk (`in`). So the tab passes no chat, and Book there is a
  walk-in at the desk.
- **`spaceTabs`** is a resource kind of Copilotz's spaces front end. One entry puts a Bookings tab
  on every space's page, and spaces never imports bookings.

### The page

`front.ts` lists the front ends the browser runs: Copilotz's web shell, chat's and spaces' front
ends, bookings', and what the sign-in page says beside its form:

```ts
const words = definePlugin({
  name: "salon-words",
  resources: { signInPage: { about: { headline: "The salon,", quiet: "for its staff." } } },
});

export const front: Plugin[] = [webShell, chatWeb, spacesWeb, bookingsWeb, words];
```

`browser.tsx` is the page's code. Copilotz's web host connects as whoever the browser is, and draws
the shell:

```tsx
await web({
  root: document.getElementById("app")!,
  plugins: front,
  start: async () => ({ space: "desk" }),
});
```

`server.ts` serves it on Node. `webPage` serves the page, and `bundle` builds `browser.tsx` with
esbuild on the first request. `devSignIn` lets anyone on this machine sign in by name:

```ts
const runtime = await createRuntime({
  store: memoryStore(),
  plugins: [
    ...plugins(),
    devSignIn,
    webPage,
    definePlugin({
      name: "page",
      resources: {
        page: { title: "The salon", code: () => bundle(new URL("./browser.tsx", import.meta.url)) },
      },
    }),
  ],
});
await openDesk(runtime);

const server = await listen(runtime.fetch, { hostname: "127.0.0.1", port });
```

### Tests that press the buttons

Node runs TypeScript, but not TSX. `tsx.ts` is a 24-line loader hook that turns `.tsx` into
JavaScript with esbuild as it loads. `npm test` (and `npm run dev`) start with `--import ./tsx.ts`,
so tests can load `web.tsx`.

`tests/web.test.ts` observes the desk's tab as Sam, the way the page does, and presses its buttons:

```ts
// Sam presses Book on Tue 10:00: a walk-in, at the desk.
await desk.buttons().book("tue-10");
// A customer books from their chat, elsewhere: the tab follows, without asking again.
const bia = await customer(runtime, "Bia");
await runtime.call("booking.make", { slot: "wed-15", thread: bia.thread }, {
  actor: bia.actor,
});
await runtime.idle();
assert.match(desk.html(), /<li>Tue 10:00, for a walk-in <button[^>]*>Cancel<\/button><\/li>/);
assert.match(desk.html(), /<li>Wed 15:00, for Bia <button[^>]*>Cancel<\/button><\/li>/);
```

## Run it

```sh
npm run dev
```

Open http://127.0.0.1:8080/space/desk. The sign-in page says "The salon, for its staff." Sign in as
`sam`, and open the desk's Bookings tab. Press Book beside Tue 10:00:

```text
Bookings
Tue 10:00, for a walk-in Cancel
Free
Tue 11:00 Book
Wed 15:00 Book
Thu 09:00 Book
Fri 14:00 Book
Sat 10:00 Book
```

And the tests:

```text
✔ staff see every booking; a customer sees only their own (71.996459ms)
✔ a customer can't book into another's chat, take a slot, or cancel what isn't theirs (35.61375ms)
✔ the page is served, with the salon's code (99.035667ms)
✔ staff's Bookings tab: every booking, live, and its buttons are the Actions (44.390708ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 650.11525
```

## What this unlocks

- **A View per medium, one read for all.** Text for the terminal and models, React for the web, the
  same named queries under both.
- **Live by default.** Whatever changes a booking, the tab follows. Chapter 5 books from an
  assistant while this tab is open.
- **No second home for the rules.** The page asks the server, as its reader, and gets what the rules
  allow.

## Your challenge

Open the desk in two windows, signed in as `sam` in both. Book in one, and watch the other. Then
make each booking made in a chat link to it: the shell shows a chat at `/thread/<id>`.

Next, the salon gets an agent of its own.
