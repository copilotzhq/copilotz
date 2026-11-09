---
title: "spaces-web"
description: "Spaces' web front end."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# spaces-web

Spaces' web front end.

```ts
import { spacesWeb } from "copilotz/plugins/access/web";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Nobody calls it: it has no Actions, tools or routes.

## Where it shows

Its Views show on the web.

- **On the web:** `invitations`, `invitations.home`, `org.about`, `org.members`, `space`,
  `space.invite`, `space.members`, `space.not-here`, `space.panel`, `space.pick`, `space.settings`,
  `spaces.palette`, `web.spaces`.
- **What it adds to resources:** `home` (`invitations`), `names` (`people`), `orgSettings` (`about`,
  `members`), `palette` (`spaces`), `panel` (`on`, `title`, `view`), `refusals` (`not_here`),
  `sidebar` (`invitations`, `spaces`), `spaceTabs` (`members`, `settings`).

## What it needs

Nothing to set. It reads `names`, `spaceAgents`, `spaceInvite`, `spaceMembers`, `spaceSidebar` and
`spaceTabs`, resource kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`spaces`](spaces.md) and [`web-shell`](web-shell.md): add them
too.

It ships with `copilotz@1.0.0-rc.32`.

## Listing

It keeps every listing rule.
