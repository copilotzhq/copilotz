# Plugins: the runtime, standard plugins, products

Agreed 2026-11-09. Copilotz shipped every plugin it had in one package: the runtime, the plugins
every app needs, and the plugins one product needed its own way (Compass's boards, its many orgs,
its credits and Stripe, its agents people make). An app that wanted none of those still had them,
and the core's own front ends imported the directory's. Now there are three layers, the product
plugins are packages of their own in this repo, and the core imports none of them.

## Three layers

1. **The runtime:** `runtime/`, the stores and blobs, the exporters, `testing/`, and the web and
   terminal hosts with their shells (`webShell`, `terminalShell`): what any app runs on.
2. **Standard plugins,** in the `copilotz` package (`copilotz/plugins/<theme>`): what most apps
   built on the promise use.
3. **Product plugins,** each a package of its own (`packages/<name>`, `@copilotz/<name>`): what one
   product does its own way.

**The test for "core":** a plugin is standard when all three hold, and a product's when any fails:

- **the promise needs it:** agents that work with people, in shared spaces, on the record, through
  any medium, on any runtime;
- **it carries no single product's policy:** no pricing, no way of working, no hosting model of one
  product's;
- **most apps use it.**

## Which plugin is where

| Plugin                                                                                                 | Where                 | Why                                                                                                                           |
| ------------------------------------------------------------------------------------------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `identity`, `spaces`, `contacts`                                                                       | standard              | who someone is, where work happens, people outside the org: the promise. Org roles (owner, admin, member, guest) are spaces'. |
| `googleSignIn`, `emailSignIn`, `devSignIn`, `api`                                                      | standard              | how people and code come in; every app has some                                                                               |
| `webShell`, `terminalShell`, `webLines`, `mcp`, `whatsapp`, `voice`, `maintenance`                     | standard              | the media the promise names, and running the app                                                                              |
| `models`, `chat`, `history`, `memory`, `memoryExtraction`, `skills`, `routines`, `webTools`, `openapi` | standard              | agents and conversations: the promise                                                                                         |
| `usage`                                                                                                | standard              | every use is metered and on the record; it's also the port pricing plugs into (`spending`, the `usage` resource's `spent`)    |
| `computers`, `cloud`, `cloudPool`, `apps`, `computerDownloads`, `accounts`                             | standard, for now     | **moving to Compass (private) later**: see below                                                                              |
| `boards`, `documents`                                                                                  | `@copilotz/work`      | one product's way of working together; most apps don't                                                                        |
| `directory`                                                                                            | `@copilotz/directory` | many orgs behind one address is a hosting model; most apps serve one org                                                      |
| `credits`, `stripe`, `stripeWebhook`                                                                   | `@copilotz/billing`   | a business's pricing: plans, credits, a payment provider                                                                      |
| `team`, `tiers`                                                                                        | `@copilotz/team`      | agents people make, and model tiers sold by plan: product policy; the app's agents in code are chat's                         |

Each package's front ends go with it: `boardsWeb` and `documentsWeb`, `directoryWeb`, `creditsWeb`,
`teamWeb` and `tiersWeb`.

**Computers, cloud computers, apps, the computer program's downloads and connected accounts stay for
now,** marked as moving to Compass (private) later. They fail the test (they're one product's way to
give agents a machine), but the computer program's binaries are built on a Mac in the publish
workflow and served from Copilotz's public GitHub releases (`computerDownloads()` reads its own
release), so moving them needs its own plan: where the program is built, signed and released, and
how computers already installed find their updates.

## The directory, decoupled

The shell (`frame.tsx`, the org page `org.tsx`, the console), spaces' sidebar and About page, and
credits' composer note imported the directory's browser half (`useOrgs`, `asStaff`, `refreshOrgs`,
`orgName`, `GiftCode`). Now the core knows no directory:

- **The web shell's `orgs` slot,** a resource (its shape, `OrgsSlot`, in the shell's contract):
  - `switcher`, a View at the top of the sidebar beside the app's mark (in place of its whole logo),
    with the sidebar's hints, drawn once `use` answers;
  - `overlay`, a View drawn once beside every page, outside the sidebar (a drawer on a phone):
    making an org, going into one, and the line along the top while in one as staff;
  - `use`, a React hook the frame calls on every draw: what the shell's own parts list (the person's
    email under their name, entries in their menu, groups in the palette), or nothing while it
    doesn't know or there's one org, and the top of the sidebar is the app's logo as before.
- **`@copilotz/directory/web`'s `directoryWeb` fills it,** and draws the org's page (`org`, at
  `/org`, its sections still the shell's `orgSettings` resource) and staff's console (`console`).
  Its words keep the keys they had in the shell (`shell.<key>`), so an app's translations hold.
  Without `directoryWeb`, there's no org switcher, no org page and no console.
- **The person's standing in the org is spaces'** (`org.me`: their role, whether they're staff, and,
  where there are many, which org), read once per page through the shell's contract (`useStanding`).
  Spaces' sidebar reads its guests and staff from it; credits' note, which org it's in. Renaming the
  org says so (`orgsChanged()`), and the directory's browser half asks again.

## Packaging

- **A folder per package,** `packages/<name>/`: its `deno.json` (JSR `@copilotz/<name>`), its
  `package.json` (npm `@copilotz/<name>`), its entry points as the plugins had them (`mod.ts`, its
  plugins; `web.tsx`, their front ends; a `terminal.ts` where one has a terminal front end), a
  `contract.ts` gathering its plugins' contracts (`@copilotz/<name>/contract`), its tests, a README
  and, where it shows words, a WORDS.md. The code moved with `git mv`.
- **Names don't change.** Collections, Actions, events, Views, routes and resources are what they
  were, so an app's data, links and webhooks stay as they are: only imports change.
- **A package imports Copilotz by its entry points** (`copilotz`, `copilotz/web`,
  `copilotz/plugins/access/contract`…) and other packages by their contracts, never a file outside
  itself, as an outside plugin would. So the core's contracts are entry points too:
  `copilotz/plugins/<theme>/contract` gathers a theme's plugins' `contract.ts` (shapes, and the
  little code that goes with them), safe in the browser. The core imports no package, its tests
  neither (`testing/boundaries.test.ts`).
- **Lockstep versions during the release candidates.** Every package carries Copilotz's version and
  depends on Copilotz at exactly it: on JSR its deno.json imports
  `jsr:@copilotz/copilotz@<version>`; on npm Copilotz is its peer at `<version>` (one runtime per
  app, as React is one). `node scripts/version.ts <version>` says a release's version everywhere,
  `testing/versions.test.ts` fails where one doesn't, and the publish workflow refuses a tag a
  package doesn't carry. Past 1.0, packages may version apart; that's for then.
- **One repo, one workspace.** Deno's (deno.json's `workspace`: a package's
  `jsr:@copilotz/copilotz@<version>` is the core here) and npm's (package.json's `workspaces`, the
  core linked as `copilotz`), so the same tests run on Deno, Node and Bun, and examples import
  `@copilotz/<name>` as apps do.
- **Built and published with the core.** `npm run build` builds Copilotz into `dist/npm/`, then each
  package into `dist/packages/<name>/`, typed by the core's build; the smoke test installs them all
  together from their tarballs and uses a plugin of each. A release attaches every tarball to its
  GitHub release, so an app can install from the release's URLs before the registries have a
  package, then publishes Copilotz and, after it, each package to JSR and npm. A package a registry
  doesn't have yet is skipped with a notice: its first version is published by hand, and the
  registry told to trust the workflow (npm) or the package linked to the repository (JSR); from the
  next release on, it publishes with the rest.

## The hub, in four phases

1. **Official packages.** This: Copilotz's own product plugins as packages, built only on Copilotz's
   entry points and each other's contracts, the shape any plugin outside will have.
2. **The declaration extractor** (`feat/declare`: `copilotz/describe` and `scripts/describe.ts`; see
   CONTRIBUTING.md). It reads what each plugin declares (collections and their schemas, Actions and
   who may call them, events, Views, routes, resources, settings) and generates the reference pages
   (`docs/reference/plugins/`) and the hub's data (`plugins.json`) from the code, not from prose:
   the standard plugins from Copilotz's entry points, the packages' from theirs, each in the layer
   `scripts/describe/catalog.ts` says.
3. **A hub index.** A `hub/` folder of entries, one per listed package (its name, registry and
   repository, what it adds), checked by CI against what the extractor finds in the package as
   published.
4. **The runtime enforcing declarations for outside plugins.** An outside plugin gets what it
   declares and nothing else: routes under its name, its own collections, `ctx.fetch` only to the
   hosts it declares, and only the keys (secrets) it declares.

## What makes a plugin listable

A plugin is listed on the hub when:

- **every collection has a schema** that names its fields;
- **every Action declares `allow`, or is internal** (without one, only the app's own code calls it,
  never a request);
- **its routes live under its name** (`/<plugin>/…`), and none takes a whole host;
- **every setting is in its contract:** each setting it reads is a type its contract exports.

A declaration's `listing` says which rules a plugin breaks.

The rule on routes is for hub-listed plugins. The standard plugins and the official packages may
declare app-level paths, and their declarations show them first, as what they take of the app's
address space: chat's `/files/*`, identity's `/me` and `/signout`, the sign-ins' `/signin/*`,
`webLines`' `/web/:name`, WhatsApp's and voice's `/hooks/*`, the page's `/*`, Stripe's webhook
`/__stripe/:seller`, and the directory's `/orgs…`, `/console/…`, `/o/:org…`, `/*` and whole hosts.
None is renamed: apps' links, webhooks and sign-in redirects point at them.

## Upgrading apps

Only imports change, and an app with many orgs adds the directory's front end to its page:

| Was                                                                  | Is                                                               |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `copilotz/plugins/work`: `boards`, `documents`                       | `@copilotz/work`                                                 |
| `copilotz/plugins/work/web`: `boardsWeb`, `documentsWeb`             | `@copilotz/work/web`                                             |
| `copilotz/plugins/access`: `directory`, `Operations`, `OrgInfo`…     | `@copilotz/directory`                                            |
| `copilotz/plugins/access/web`: `useOrgs`, `enterOrg`, `refreshOrgs`… | `@copilotz/directory/web` (or `/contract`)                       |
| (the shell's own org switcher, org page and console)                 | `directoryWeb`, from `@copilotz/directory/web`, on the page      |
| `copilotz/plugins/billing`: `credits`, `stripe`, `stripeWebhook`     | `@copilotz/billing` (`usage` stays `copilotz/plugins/billing`)   |
| `copilotz/plugins/billing/web`: `creditsWeb`                         | `@copilotz/billing/web`                                          |
| `copilotz/plugins/agents`: `team`, `tiers`                           | `@copilotz/team`                                                 |
| `copilotz/plugins/agents/web`: `teamWeb`, `tiersWeb`                 | `@copilotz/team/web`                                             |
| other plugins' `contract.ts`, by path                                | `copilotz/plugins/<theme>/contract`, `@copilotz/<name>/contract` |

On Deno, an app names each in its import map beside Copilotz, at the same version
(`"@copilotz/work": "jsr:@copilotz/work@<version>"`); on npm, it installs them
(`npm install @copilotz/work@<version>`), or, before npm has them, from the release's tarballs.

## Open

- **Computers, cloud computers, apps, downloads and accounts to Compass:** their own plan (the
  program's build, signing and releases).
- **Versions apart** once past the release candidates, if a package changes faster than Copilotz.
- **Routes under a name for official packages:** only where an app's address space would gain from
  it, with redirects; none is planned.
