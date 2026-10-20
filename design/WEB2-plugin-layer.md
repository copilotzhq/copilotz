# WEB2 plugin adoption fixes

## Current state

- `plugins/ui-kit/patterns.tsx:1` and several Views import React only as a type,
  relying on the repository automatic JSX setting. The product's bundler
  overrides JSX transformation to compensate. Its generic form, feedback, tabs,
  menu, confirmation, boundary and frame implementations are the inputs for the
  shared kit.
- `deno.json:57` exposes the web entries but has no CSS subpath.
  `scripts/check-package-surface.ts:69` treats every export as TypeScript.
- `plugins/ui/views/workspace/index.tsx:15` embeds navigator and palette in the
  pane renderer. `plugins/ui/web.ts:15` only supports open/swap/close.
  `client/web/storage.ts:20` persists JSON query parameters; it remains
  untouched.
- `plugins/core/views/thread/index.tsx:156` reads title; the schema declares
  name at `plugins/core/collections/thread/index.ts:84`. The list and creation
  form also use title. The message content selection is private to the View.
- Admin query Views already call aliases
  (`plugins/admin/views/query/index.tsx:65`), but the web registry fixes their
  IDs and has no detail Views. Agents are Resources returned by the agents
  query; participants have a Collection.

## Target and public API

Keep all UI dependencies in plugins and use one kit. Copy generic product
components into ui-kit with relative imports, explicit React runtime imports and
file-level classic JSX directives so consumer Deno settings cannot choose the
wrong runtime. Existing and new web TSX must work under classic and automatic
consumer configurations. Export `/web/kit/styles.css`; surface checks inspect
assets separately and still check all executable entries and release types.
Publication verification found that Deno 2.9.2 rejects CSS JSR exports. Keep the
asset in the JSR archive and add an npm source manifest exposing the CSS subpath
and mirroring executable exports. This adds no runtime implementation; npm
bundlers compile the same TS/TSX. Check both archives and document the npm
registry setup for JSR dependency aliases. Preserve Deno's previous global-cache
mode explicitly when adding package.json. Mirror the existing minimum-age
exceptions for those same dependencies' npm aliases.

Kit additions: Tabs family, DropdownMenu family, Field, NativeSelect, Checkbox,
Notice, EmptyState, CopyField, ConfirmAction, PaneBoundary, showSafely, Frame.
Frame uses View density; dialog bodies use Dialog semantics, full/panel bodies
use Screen. Workspace dialog hosts fill the viewport on small screens.
ConfirmAction contains errors and prevents duplicate pending submissions.

The UI plugin registers independent `ui.panes` (shows `workspacePanes`) and
`ui.navigator` (shows `workspaceNavigator`) Views. `ui.workspace` composes their
outputs during tracked rendering. Export the View definitions for composition.
Panes own focus/context, close/swap controls and a dialog reference. Navigator
owns links and the keyboard palette. Read Collections only inside View render.
Add `replace` (one region, no focus demotion), `set` and `restore` (exact pane
snapshot) commands and `uiReplace`, `uiSet`, `uiRestore` Action aliases. Keep
existing open behavior; mode dialog targets the dialog region.

Add plugin-owned `workspaceUrlStorageAdapter(host, codec)`, with codec
`decode(URL)` and `encode(URL, state)` hooks. It implements the existing storage
port without changing client/web. Apps supply readable routes; snapshots include
all three regions and can be restored by uiRestore on history navigation.

Core uses name in headers, lists and creation; exports `messageReadSelection`
and `readThreadMessages`. Stop runs only after ConfirmAction acceptance. Admin
exposes `createAdminWebPlugin({ actionIds })` and the default plugin; all Views
use aliases. Agent detail selects public agent query output; participant detail
reads the authorized participant Collection by ID. Query rows navigate to detail
Views.

## Deletions and guarantees

Replace the monolithic workspace body with composition; remove private
Navigator, duplicated message selection, title field access and direct Stop
cancellation. Preserve navigation demotion, swap densities, read tracking,
authorization through existing reads, cancellation of the exact active handle,
and browser graphs free of server implementation closures. No product-specific
resource contracts are copied. No client, server or subscription edits.

## Verification and risks

SSR tests cover kit exports, standalone/composed UI, thread names, alias-based
admin results and details. DOM tests cover confirmation/cancel/failure, pane
isolation and navigation. Test workspace mutations and readable URL round trips.
A consumer configuration check covers classic JSX without repository options;
package surface and publish dry-run cover every web entry and CSS. Run existing
WEB tests, then full suites using PGlite and Postgres on 55436 with the required
timeout runner. Document any existing failures separately.

Radix portals need a DOM for interactive verification. Deno's publication
checker requires explicit exported types even when ordinary type checking
passes. The URL codec is host-owned; do not invent app route conventions or
persist secrets.
