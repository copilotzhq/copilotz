---
title: "directory"
description: "The directory plugin, and what each org's runtime gets of it: `directory.member(dir, org)` (see shared/member.ts), with the org as `org.info` says it."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# directory

The directory plugin, and what each org's runtime gets of it: `directory.member(dir, org)` (see
shared/member.ts), with the org as `org.info` says it.

```ts
import { directory } from "@copilotz/directory";
```

## What it keeps

It keeps 6 collections, each on the record: every change to one is an event.

| Collection   | Kept as   | Fields                                                                                  |
| ------------ | --------- | --------------------------------------------------------------------------------------- |
| `creditCode` | documents | `amount`, `expires`, `until`, `note`, `by`, `at`, `org`, `person`, `claimed`, `revoked` |
| `invite`     | documents | `org`, `email`, `role`, `by`, `from`, `at`                                              |
| `membership` | documents | `org`, `person`, `role`, `entered`, `at`                                                |
| `org`        | documents | `name`, `kind`, `by`, `placement`, `suspended`, `summary`, `at`                         |
| `orgHost`    | documents | `org`, `target`, `at`                                                                   |
| `staff`      | documents | `at`                                                                                    |

Its named queries read for callers, as the rules let them:

| Query             | Who outside runs it |
| ----------------- | ------------------- |
| `org.info`        | the app's code      |
| `orgHost.resolve` | the app's code      |

## What it lets callers do

Only the app's own code calls its 21 Actions, `code.claim`, `code.create`, `code.list`,
`code.revoke`, `host.claim`, `host.release`, `invite.answer`, `invite.cancel`, `invite.mine`,
`invite.org`, `invite.send`, `org.create`, `org.delete`, `org.enter`, `org.leave`, `org.list`,
`org.mine`, `org.place`, `org.rename`, `org.report` and `org.suspend`: its plugins, its schedules
and the system. Nobody outside does.

It answers 14 routes over HTTP:

| Method    | Path                        |
| --------- | --------------------------- |
| ANY       | `*://*:*/*`                 |
| ANY       | `/*`                        |
| GET       | `/__copilotz/hosts/resolve` |
| GET, POST | `/console/codes`            |
| POST      | `/console/codes/revoke`     |
| GET       | `/console/orgs`             |
| GET, POST | `/console/orgs/:org`        |
| GET, POST | `/console/orgs/:org/:what`  |
| ANY       | `/o/:org`                   |
| ANY       | `/o/:org/*`                 |
| GET, POST | `/orgs`                     |
| POST      | `/orgs/enter`               |
| POST      | `/orgs/invites/answer`      |
| POST      | `/signout`                  |

## Where it shows

It has no Views of its own: its front ends show it, [`directory-web`](directory-web.md).

- **What it adds to resources:** `cookies` (`names`).

## What it needs

You set it in `resources.directory`.

| Setting                | Type         | Required | What it is |
| ---------------------- | ------------ | -------- | ---------- |
| `directory.pool`       | `string`     | no       |            |
| `directory.staff`      | `string[]`   | no       |            |
| `directory.orgs`       | `Runtimes`   | no       |            |
| `directory.lobby`      | `object`     | no       |            |
| `directory.operations` | `Operations` | no       |            |

It also reads `caller`, resource kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`identity`](identity.md): add it too.

It ships in a package of its own, `@copilotz/directory@1.0.0-rc.33`, for `copilotz` `1.0.0-rc.33`:
install it beside `copilotz`.

## Listing

It breaks 14 listing rules as it is:

- Route "_://_:_/_" takes whole hosts, not paths under /directory.
- Route "/*" isn't under /directory.
- Route "/__copilotz/hosts/resolve" isn't under /directory.
- Route "/console/codes" isn't under /directory.
- Route "/console/codes/revoke" isn't under /directory.
- Route "/console/orgs" isn't under /directory.
- Route "/console/orgs/:org" isn't under /directory.
- Route "/console/orgs/:org/:what" isn't under /directory.
- Route "/o/:org" isn't under /directory.
- Route "/o/:org/*" isn't under /directory.
- Route "/orgs" isn't under /directory.
- Route "/orgs/enter" isn't under /directory.
- Route "/orgs/invites/answer" isn't under /directory.
- Route "/signout" isn't under /directory.
