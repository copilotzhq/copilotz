---
title: "Chapter 8: Spaces on the web"
description: "Give spaces a web front end: React Views the web shell places by name, a page for each space, and resource kinds that let other plugins add tabs without knowing your code."
section: Getting Started
order: 80
status: stable
---

# Chapter 8: Spaces on the web

> Part 2, your own plugins · Requires: Chapter 7 · Code: `lesson-2.5`

## The pain

Spaces exist, but the page doesn't show them: chats go to your Personal space, and there's no way to
make another, open one, or see what's in it.

## The problem

A space's page has to show what other plugins put in a space: chat's conversations now, a board in
Part 3. If the page knew each of them, every new plugin would mean editing it. The page needs places
where others plug in, by name, without importing each other's code.

## The solution

### A front end is a plugin of Views

`spacesWeb` (`plugins/spaces/web.tsx`) is spaces' front end: a plugin made of web Views and the
resources that place them. Only the browser loads it; the server never does.

```ts
export const spacesWeb: Plugin = definePlugin({
  name: "spaces-web",
  requires: ["spaces", "web-shell"],
  views: {
    "web.spaces": spacesView,
    space: spaceView,
    "space.settings": settingsView,
    "space.panel": spacePanelView,
    "space.pick": spacePickView,
    "spaces.palette": spacesPaletteView,
  },
  resources: {
    names: { people: { collection: "person" } },
    sidebar: { spaces: { title: "Spaces", view: "web.spaces", order: 10 } },
    spaceTabs: {
      settings: {
        title: "Settings",
        view: "space.settings",
        icon: "settings",
        order: 90,
        own: "General",
        menu: "side",
      },
    },
    panel: { view: "space.panel", on: ["thread"], title: "Space" },
    palette: { spaces: { view: "spaces.palette", order: 10 } },
  },
});
```

The web shell finds everything here by name:

- **By address.** `/space/<id>` shows the View named `space`, with item `{ _id }`. The shell splits
  the path: its first part names the View.
- **By resource kind.** The shell reads `sidebar` (sections of the sidebar), `panel` (the side panel
  beside a page) and `palette` (the command palette's sources). `spacesWeb` adds to each.

A web View is a function from an item and a context to React elements. The sidebar's
(`views/web/spaces.tsx`) reads your spaces with the same query the terminal used:

```tsx
export const spacesView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const spaces = ctx.db.collection("space").query<Reached[]>("reached", {}).value;
  if (spaces === undefined) return <Skeleton height={72} />;
  const ordered = [...spaces].sort((a, b) =>
    Number(b.kind === "personal") - Number(a.kind === "personal") || a.name.localeCompare(b.name)
  );
  // …
  return (
    <>
      <ul className="spaces-list">{rows(false)}</ul>
      <NewSpace
        create={async (name) => {
          const { space } = await ctx.call<{ space: string }>("space.create", { name });
          go(spacePath(space));
        }}
      />
    </>
  );
};
```

`ctx.call` from a handler is an Action call, as you, under the rules: a click calls `space.create`
exactly as the terminal's `/space` does. The View doesn't refresh itself: it's observed, so when the
new space is committed, the query it read changes and it renders again. Buttons, pages, tabs and the
rest come from `copilotz/web`, the web host's toolkit, so front ends look alike and follow the app's
theme.

### A resource kind as a place to plug in

A space's page (`views/web/space.tsx`) shows its name, then tabs, but it doesn't know which tabs
there are. They come from a resource kind, `spaceTabs`, that any front end may add to:

```tsx
export const spaceView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const spaces = ctx.db.collection("space").query<Reached[]>("reached", {}).value;
  if (spaces === undefined) return <Page title={<Skeleton width={220} height={30} />} />;
  const space = spaces.find((space) => space._id === item._id);
  // … a page saying it doesn't exist, when it doesn't
  const tabs = tabsOf(ctx.resources.spaceTabs);
  const query = (ctx.hints.query ?? {}) as Record<string, string>;
  const tab = chosen(tabs, query.tab);
  // … `shown`: the tab, or its section the address names; `href`: a tab's address
  return (
    <Page title={space.name} width="lg" icon={space.kind === "personal" ? "person" : "folder"}>
      <Tabs
        label={`${space.name} tabs`}
        value={tab.key}
        variant="line"
        onChange={(key) => go(href(key))}
        tabs={tabs.map((tab) => ({
          value: tab.key,
          label: tab.title,
          icon: tab.icon,
          href: href(tab.key),
        }))}
      />
      {ctx.show(shown.view, { _id: space._id }, { in: space._id, mode: "page" })}
    </Page>
  );
};
```

`ctx.show(name, item, hints)` renders the View registered under that name, whoever registered it.
Chat's front end already adds a Chats tab to `spaceTabs`, because Copilotz's spaces has the same
resource kind; your page shows it with no change to either. In Part 3 the board adds a Board tab the
same way. That's the third way plugins reach each other, beside calling Actions and hearing events:
**plugging into resource kinds**.

The shapes of `spaceTabs` and `spaceSidebar` are in `contract.ts`, the one file other plugins may
import from spaces.

### In the page

`front.ts` adds `spacesWeb` beside chat's front end:

```ts
export const front: Plugin[] = [webShell, chatWeb, spacesWeb, compassWeb, compassTheme];
```

## Run it

The sidebar lists your spaces, Personal first, each unfolding its latest chats (chat's
`spaceSidebar` entry), with each chat's name from Chapter 6. "New space" makes one and opens its
page: its name, a Chats tab, and Settings, where you rename it, pick the agent that answers its new
chats, or archive it.

## Check it

`tests/web.test.ts` renders the shell's `space` View for a space, with chat, spaces and a test
plugin of its own each adding a tab, and checks all three are there: a front end extended by plugins
it has never heard of.

## What you have now

Two of Copilotz's plugins rebuilt, each with a terminal and a web front end, and the three ways
plugins reach each other: Actions, events, and resource kinds. Part 3 builds a feature on all of it:
the board.
