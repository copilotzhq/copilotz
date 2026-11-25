---
title: "A business app's screens"
description: "The screens back-office apps are made of, the Copilotz way: one View per file, the app's own shared components in lib/, Views that read and handlers that save, an app's own frame and home, lists with search, filters, paging and exports, forms in dialogs, dates, sign-in, printed documents, shortcuts and files, all from the toolkit with no CSS."
section: Guides
order: 9
---

# A business app's screens

A back-office app is mostly screens: lists to search and export, forms that add and change records,
dates, a home page of places, a printed document or two. This guide builds them for the salon's
staff: its customers, their visits, and the services it offers. Each recipe is whole files, in the
place they go, and each compiles against `copilotz@1.0.0-rc.64`.

The pieces themselves (every prop, every token) are in [the web toolkit](the-web-toolkit.md). This
guide is how to put them together.

## The rules every screen keeps

- **Views read; handlers save.** A View reads in its own body, with `ctx.db`, and hands what it read
  to React components. When a commit changes what it read, it runs again and the screen redraws: no
  fetching in effects, no polling, no refresh button. A handler (a click, a submit) saves with the
  View's collections (`insertOne`, `updateOne`, `deleteOne`), as the person, under the rules and the
  schema; what's more than a save is an Action, called with `ctx.call`. A View never writes while it
  renders.
- **Screens read named queries.** In the browser, a View's own `find` reaches only a collection a
  rule speaks for (the `shared` resource, or a `guard`); any other answers `forbidden`, and the part
  says "You can't see this here". A named query with an `allow` (`people`) runs on the server, as
  whoever asks, and answers just what the screen shows: every read below is one.
- **One View per file.** A plugin's front end is `plugins/<name>/views/web/`, a file per View. Give
  each View a default export. `copilotz gen` assembles the web entry point. React components aren't
  Views: they live in `lib/`, the plugin's for its own screens and the app's for what every plugin's
  screens share ([shared UI](#shared-ui-an-apps-own-components)). The data's side is a folder per
  primitive: `collections/` (each with its schema, its type and its named queries), `actions/` for
  business logic.
- **The toolkit, and no CSS.** Screens are made of `copilotz/web`'s pieces, layout included (`Page`,
  `Stack`, `Grid`, `Toolbar`, `Split`, `Card`). The look is the app's theme. No stylesheet, no
  `style={{…}}` for looks, no rules on the toolkit's `.copilotz-*` classes. A printed document's
  print layout is the one exception. What the toolkit lacks is a gap to report, not a reason for
  CSS.
- **Settings are resources.** The time zone, the date formats and the words are the app's, never the
  browser's locale.
- **The schema checks every save.** A form helps people fill it in (`required`, `type="email"`). The
  schema checks the save again, for every caller, and names the field it refuses; an Action checks
  what a schema can't say. Either refusal is what the form shows.

## Files and names

Start with `copilotz init`. In a generated customers plugin the files go here:

```text
app.ts                                lists #copilotz/plugins/customers/mod.ts on the server
front.ts                              lists #copilotz/plugins/customers/web.ts in the browser
lib/web/status-badge.tsx              a React component any plugin can import
plugins/customers/
  plugin.ts                           defaults.allow, requires and the guard
  contract.ts                         types another plugin may import
  collections/customer.ts             defineCollection<Customer> with its named queries
  views/web/screen/customers.tsx       screen:customers
  views/web/dialog/customer.tsx        dialog:customer
  lib/web/customer-form.tsx          a component used by the dialog
```

Type an Action's input on `run`. Use a document type in `defineCollection<T>` and put named queries
beside it. The [compiler guide](the-compiler.md) shows the declarations and generated imports. The
worked salon recipes below use the hand-written alternative. In a generated plugin, use the paths
above and default-export the View functions in those recipes.

A View's name says where it shows:

| Name             | What it is                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `screen:<place>` | a whole screen, at `/<place>…`, which the frame shows for the address                       |
| `dialog:<name>`  | a dialog over a screen, at an address of that screen (`/customers/12`), shown by the screen |
| `panel:<name>`   | a part of another View that reads its own data (a customer's last visits, in their dialog)  |

Names are conventions, not a router: the frame below turns `/customers/…` into `screen:customers`.
Under Copilotz's own shell (`webShell`), an address `/<kind>/<id>` shows the View named `<kind>`, or
`web.<kind>`, given `{ _id }`; this guide's apps draw their own frame instead.

### Shared UI: an app's own components

Screens share more than the toolkit's pieces: a status badge every list shows, a table with the
app's page sizes and exports, a form section (an address's fields) several dialogs hold. Those are
the app's own components, made of the toolkit's pieces, and they live in `lib/`:

- **A plugin's `lib/web/`** for what its own screens share, and for a component one View draws (a
  screen's keyboard shortcuts need one: the visits board below).
- **The app's `lib/web/`**, beside `plugins/`, for what every plugin's screens share. It isn't a
  plugin, so any plugin imports it; `boundaries()` checks imports between plugins only.

Files in `lib/` are never read as declarations: they're plain modules, and export what they like.
Views stay one per file, in `views/web/`: don't group Views in a file, or put components among them.
A shared component composes the toolkit and leaves the look to the theme, as a screen does.

```tsx
// lib/web/status-badge.tsx
import { Badge, type Tone } from "copilotz/web";
import type { ReactNode } from "react";

const TONES: Record<string, Tone> = {
  open: "info",
  paid: "success",
  overdue: "warning",
  void: "neutral",
};

/** An invoice's or an order's status, the same on every screen that shows one. */
export function StatusBadge({ status }: { status: string }): ReactNode {
  return <Badge tone={TONES[status] ?? "neutral"}>{status}</Badge>;
}
```

A list's column shows it, from any plugin:

```tsx
import { StatusBadge } from "../../../../lib/web/status-badge.tsx";

const status: Column<Invoice> = {
  key: "status",
  title: "Status",
  render: (invoice) => <StatusBadge status={invoice.status} />,
};
```

```tsx
// plugins/customers/web.tsx
import { definePlugin, type Plugin } from "copilotz";
import { customerDialog } from "./views/web/customer-dialog.tsx";
import { customersScreen } from "./views/web/customers-screen.tsx";

/** Customers' web front end: each View is a file of views/web/; this only names them. */
export const customersWeb: Plugin = definePlugin({
  name: "customers-web",
  views: {
    "screen:customers": customersScreen,
    "dialog:customer": customerDialog,
  },
});
```

## The frame and its home

A business app without Copilotz's sidebar draws its own frame: a `TopBar` (a clock, who's signed in,
Sign out), an `AppBar` of places, the screen the address names, and `Toasts`. The web host observes
the View named `web.shell` for the address it's at, with a `Where` (`{ path, query }`). Home is a
`Page` of `TileGrid` tiles, one per place.

The salon's time zone and formats are a resource of its own, `formats`, read by every screen:

```ts
// plugins/look/contract.ts
/** Where the salon is, and how it writes dates: settings, never the browser's own. */
export type Formats = { timeZone: string; day: string; dayTime: string };

/** The `formats` resource, over the defaults. */
export const formatsOf = (resources: Record<string, unknown>): Formats => ({
  timeZone: "UTC",
  day: "dd/MM/yyyy",
  dayTime: "dd/MM/yyyy HH:mm:ss",
  ...(resources.formats as Partial<Formats> | undefined),
});
```

```ts
// plugins/look/mod.ts
import { definePlugin, type Plugin } from "copilotz";

/** The salon's look, words and formats: among the page's plugins, and the server's first paint. */
export const look: Plugin = definePlugin({
  name: "look",
  resources: {
    theme: {
      light: { primary: "#6d28d9" },
      dark: { primary: "#a78bfa" },
      // Sizes are tokens too: a wider list page, and the home's tiles centred.
      tokens: { "page-width-lg": "1180px", "tile-justify": "center" },
    },
    formats: { timeZone: "Europe/London", day: "dd/MM/yyyy", dayTime: "dd/MM/yyyy HH:mm:ss" },
    words: { "toolkit.noRows": "Nothing here yet." },
    signInPage: { about: { headline: "The salon,", quiet: "for its staff." } },
  },
});
```

```tsx
// plugins/frame/views/web/shell.tsx
import type { ViewContext } from "copilotz";
import {
  AppBar,
  Button,
  LiveClock,
  Page,
  signOut,
  Stack,
  Text,
  TileGrid,
  Toasts,
  TopBar,
} from "copilotz/web";
import type { IconLike, Where } from "copilotz/web";
import type { ReactNode } from "react";
import { formatsOf } from "../../../look/contract.ts";

/** The salon's places, in the bar's order: each is the View `screen:<key>`, at `/<key>`. */
const PLACES: { key: string; label: string; icon: IconLike; description: string }[] = [
  {
    key: "visits",
    label: "Visits",
    icon: "note",
    description: "Who comes when, and what they had",
  },
  { key: "customers", label: "Customers", icon: "users", description: "Everyone who books" },
  { key: "services", label: "Services", icon: "tags", description: "What the salon offers" },
  { key: "reports", label: "Reports", icon: "chart", description: "Takings, by day" },
];

/** The app's frame, the View the web host observes for the address: bars, the screen, toasts. */
export const shell = (where: Where, ctx: ViewContext<ReactNode>): ReactNode => {
  const [place] = where.path.split("/").filter(Boolean);
  const { timeZone, dayTime } = formatsOf(ctx.resources);
  const screen = place
    ? ctx.show(`screen:${place}`, where) ?? <Page title="Not found">{null}</Page>
    : (
      <Page title="Good to see you" width="lg" align="center">
        <TileGrid
          label="Places"
          tiles={PLACES.map((p) => ({
            href: `/${p.key}`,
            label: p.label,
            icon: p.icon,
            description: p.description,
          }))}
        />
      </Page>
    );
  return (
    <Stack gap="none">
      <TopBar
        start={<LiveClock format={dayTime} timeZone={timeZone} />}
        center="The salon"
        end={
          <Stack direction="row" gap="sm" align="center">
            <Text size="sm">{ctx.viewer?.label ?? ctx.viewer?.name}</Text>
            <Button variant="link" size="xs" onClick={() => void signOut()}>Sign out</Button>
          </Stack>
        }
      />
      <AppBar
        brand="The salon"
        href="/"
        active={place}
        items={PLACES.map((p) => ({ href: `/${p.key}`, key: p.key, label: p.label, icon: p.icon }))}
      />
      <main>{screen}</main>
      <Toasts placement="bottom-end" />
    </Stack>
  );
};
```

```tsx
// plugins/frame/web.tsx
import { definePlugin, type Plugin } from "copilotz";
import { shell } from "./views/web/shell.tsx";

/** The app's frame: its `web.shell` replaces the Copilotz shell's, so list it after any other. */
export const frameWeb: Plugin = definePlugin({ name: "frame-web", views: { "web.shell": shell } });
```

The page runs the look first and the frame last (its `web.shell` is the one drawn), and the server
gives the same look to the page's first paint and the sign-in page:

```ts
// front.ts
import type { Plugin } from "copilotz";
import { customersWeb } from "./plugins/customers/web.tsx";
import { frameWeb } from "./plugins/frame/web.tsx";
import { look } from "./plugins/look/mod.ts";
import { visitsWeb } from "./plugins/visits/web.tsx";

/** The plugins the page runs: the look, each plugin's front end, and the frame. */
export const front: Plugin[] = [look, customersWeb, visitsWeb, frameWeb];
```

```tsx
// browser.tsx
import { web } from "copilotz/web";
import { front } from "./front.ts";

await web({ root: document.getElementById("app")!, plugins: front });
```

```ts
// app.ts
import type { Plugin } from "copilotz";
import { access, passwordSignIn } from "copilotz/plugins/access";
import { customers } from "./plugins/customers/mod.ts";
import { visits } from "./plugins/visits/mod.ts";

export function plugins(): Plugin[] {
  return [...access, passwordSignIn, customers, visits];
}
```

```ts
// server.ts
import { createRuntime, definePlugin } from "copilotz";
import { memoryStore } from "copilotz/stores/memory";
import { bundle, listen } from "copilotz/web/node";
import { webPage } from "copilotz/web/server";
import { themeOf } from "copilotz/web/theme";
import { plugins } from "./app.ts";
import { look } from "./plugins/look/mod.ts";

const runtime = await createRuntime({
  store: memoryStore(),
  plugins: [
    ...plugins(),
    webPage,
    definePlugin({
      name: "page",
      resources: {
        page: { title: "The salon", code: () => bundle(new URL("./browser.tsx", import.meta.url)) },
        // The page's first paint, and the sign-in page, in the salon's look.
        theme: themeOf([look]),
      },
    }),
  ],
});
await listen(runtime.fetch, { hostname: "127.0.0.1", port: 8080 });
```

- ``ctx.show(`screen:${place}`, where)`` shows the screen as a part of the frame: it runs again on
  its own when what it read changes, and the bars don't.
- A screen is a `Page`: its title, its `actions`, and a `width` (`lg` for a list, `full` for a wide
  form). The frame gives it no padding of its own.
- `Toasts` goes in once, in the frame. Any handler then says a few seconds' word with `toast()`.
- Icons are the toolkit's by name. An app's own glyph is `<Icon drawing={…} />`, never an image
  restyled with CSS.
- The home's tiles are centred by a token of the theme (`tile-justify`), as the list page is widened
  by one (`page-width-lg`): sizes and placements are tokens, not CSS.

## A list: search, filters, paging and exports

A list that may grow past a few thousand rows pages on the server. Its named query takes the table's
state (`search`, `sort`, `order`, `offset`, `limit`) and the screen's filters, and answers a page
and how many match:

```ts
// plugins/customers/collections/customer.ts
import { defineCollection, type Filter, type Infer, people } from "copilotz";
import type { CustomerPage, PageParams } from "../contract.ts";

const schema = {
  type: "object",
  properties: {
    // Something besides spaces.
    name: { type: "string", pattern: "\\S" },
    phone: { type: "string" },
    // Empty, or an address.
    email: { type: "string", pattern: "^$|^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" },
    /** The salon's day they first came, `YYYY-MM-DD`. */
    since: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    archived: { type: "boolean" },
  },
  required: ["name", "since"],
  additionalProperties: false,
} as const;

/** A customer, as the schema says: the type follows it. */
export type Customer = Infer<typeof schema> & { _id: string };

/** What someone typed, matched as it is: a search box's text is never a pattern. */
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const customer = defineCollection({
  schema,
  queries: {
    /** `customer.page`: one page of customers, searched, filtered and sorted in the store. */
    page: {
      allow: people,
      run: async (customers, params: PageParams): Promise<CustomerPage> => {
        const filter: Filter = {
          ...(params.search ? { name: { $regex: literally(params.search), $options: "i" } } : {}),
          ...(params.from && params.to ? { since: { $gte: params.from, $lte: params.to } } : {}),
          ...(params.archived ? {} : { archived: { $ne: true } }),
        };
        const sort = { [params.sort ?? "name"]: params.order === "desc" ? -1 : 1 } as const;
        const [rows, total] = await Promise.all([
          customers.find(filter, { sort, skip: params.offset, limit: params.limit }),
          customers.countDocuments(filter),
        ]);
        return { rows, total };
      },
    },
    /** `customer.one`: a customer, for their dialog. */
    one: {
      allow: people,
      run: (customers, { _id }: { _id: string }) => customers.findOne({ _id }),
    },
    /** `customer.choices`: who can be picked, as a picker's options. */
    choices: {
      allow: people,
      run: async (customers) =>
        (await customers.find({ archived: { $ne: true } }, { sort: { name: 1 } }))
          .map((c) => ({ value: c._id, label: c.name })),
    },
  },
});
```

```ts
// plugins/customers/contract.ts
import { failure } from "copilotz";
import type { Customer } from "./collections/customer.ts";

export type { Customer };

/** What `customer.page` is asked: the table's state, and the screen's filters. */
export type PageParams = {
  search: string;
  sort?: string;
  order: "asc" | "desc";
  offset: number;
  limit: number;
  /** Customers who first came in this range of days. */
  from?: string;
  to?: string;
  archived?: boolean;
};

/** A page of customers, and how many match. */
export type CustomerPage = { rows: Customer[]; total: number };

/** An Action's refusal a form shows by one field: words for anyone, and the field in `detail`. */
export const refusal = (field: string, message: string) =>
  Object.assign(failure("invalid", message, { public: true }), { detail: { field } });
```

No Action saves a customer: adding or changing one is a plain save, so the dialog writes the
collection, as an import script (`connect()`) and REST would. The schema checks every one, and the
`shared` rule (or the guard) says who may.

```ts
// plugins/customers/mod.ts
import { definePlugin, type Plugin } from "copilotz";
import { customer } from "./collections/customer.ts";

export const customers: Plugin = definePlugin({
  name: "customers",
  collections: { customer },
});
```

The screen keeps the table's state and its filters in the page's address, so the View reads them
from `where`, Back undoes a page or a filter, and a dialog over the list returns to the same place:

```tsx
// plugins/customers/views/web/customers-screen.tsx
import type { ViewContext } from "copilotz";
import {
  Button,
  Checkbox,
  DataTable,
  DateRangePicker,
  go,
  IconButton,
  Page,
  Stack,
} from "copilotz/web";
import { tableAddress, tableQuery, todayIn, Toolbar } from "copilotz/web";
import type { Column, Where } from "copilotz/web";
import type { ReactNode } from "react";
import { formatsOf } from "../../../look/contract.ts";
import type { Customer, CustomerPage } from "../../contract.ts";

const columns: Column<Customer>[] = [
  { key: "name", title: "Name" },
  { key: "phone", title: "Phone", nowrap: true },
  { key: "email", title: "Email" },
  { key: "since", title: "Since", nowrap: true },
  {
    key: "edit",
    title: "",
    label: "Edit",
    render: (c) => (
      <IconButton icon="pencil" label={`Edit ${c.name}`} size="sm" href={`/customers/${c._id}`} />
    ),
  },
];

/** `screen:customers`, at `/customers`: the list, and the dialog its address opens over it. */
export const customersScreen = (where: Where, ctx: ViewContext<ReactNode>): ReactNode => {
  const [, open] = where.path.split("/").filter(Boolean); // "new", or a customer's id
  const table = tableAddress(where, 25);
  const { from, to, archived } = where.query ?? {};
  const found = ctx.db.collection("customer").query<CustomerPage>("page", {
    ...table.state,
    from,
    to,
    archived: archived === "yes",
  });
  const { day, timeZone } = formatsOf(ctx.resources);
  // A filter is in the address too, from the first page: Back takes it off again.
  const filter = (extra: Record<string, string | undefined>) =>
    go(`/customers${tableQuery(where, { ...table.state, offset: 0 }, extra)}`);
  return (
    <Page
      title="Customers"
      width="lg"
      actions={<Button variant="primary" icon="plus" href="/customers/new">New customer</Button>}
    >
      <Stack gap="lg">
        <Toolbar
          end={
            <>
              <Checkbox
                label="Archived too"
                checked={archived === "yes"}
                onChange={(e) => filter({ archived: e.target.checked ? "yes" : undefined })}
              />
              <DateRangePicker
                label="Customers since"
                value={from && to ? { start: from, end: to } : undefined}
                onChange={(range) => filter({ from: range.start, to: range.end })}
                today={todayIn(timeZone)}
                format={day}
                presets
              />
            </>
          }
        />
        <DataTable
          {...table}
          label="Customers"
          columns={columns}
          rows={found.value?.rows ?? []}
          total={found.value?.total ?? 0}
          loading={found.status === "loading"}
          rowKey={(c) => c._id}
          exportName="customers"
        />
      </Stack>
      {open
        ? ctx.show("dialog:customer", { _id: open, back: `/customers${tableQuery(where)}` })
        : null}
    </Page>
  );
};
```

- **`tableAddress(where, 25)`** gives the table its `state` and `onState`: a new page, sort or
  search moves the address (`go()`), and the View reads the query again. `total` puts the table in
  server mode: `rows` is the page.
- **Filters** sit in a `Toolbar` over the table (`end` for filters and dates, `start` for the
  screen's buttons, `grow` for a field that takes the room left). Each moves the address with
  `tableQuery(where, state, extra)`, back to the first page; an `undefined` value takes a key away.
- **A column titled `""`** holds links or buttons: it isn't sorted, searched or exported, and its
  `label` names it for screen readers. `text` is what search, sorting and files use when a cell is
  formatted.
- **Exports:** the menu saves the visible columns of the rows shown, as `<exportName>.csv`, `.xlsx`
  or `.pdf` (`exports` picks the formats). In server mode that's the page. To export every matching
  row, either give the table every row (the visits list under Dates: `exportAll`), or add an Action
  with `record: false` that returns them, and a `Menu` in the table's `actions` that saves them with
  `download(format, { headers, rows }, name)`. Totals in a table's `footer` aren't exported: put
  them in the sheet yourself when the file needs them.
- **Search in the store** is a `$regex` with `$options: "i"`, and what someone typed is escaped
  first: it's text, never a pattern.

## A form in a dialog

A record opens in a dialog over its list, at an address of the list's (`/customers/new`,
`/customers/<id>`): Back closes it, a link opens it, and closing goes back to the list as it was.
The dialog's View reads the record. The form is a React component, so it can keep what's typed: a
View is a function the runtime runs again, and holds no state or hooks.

```tsx
// plugins/customers/views/web/customer-dialog.tsx
import type { ViewContext } from "copilotz";
import { Dialog, go, todayIn } from "copilotz/web";
import type { ReactNode } from "react";
import { formatsOf } from "../../../look/contract.ts";
import type { Customer } from "../../contract.ts";
import { CustomerForm } from "../../lib/web/customer-form.tsx";

/** `dialog:customer`: a customer's form over the list (`_id` "new" for a new one). */
export const customerDialog = (
  item: { _id: string; back: string },
  ctx: ViewContext<ReactNode>,
): ReactNode => {
  const fresh = item._id === "new";
  const found = fresh
    ? undefined
    : ctx.db.collection("customer").query<Customer | null>("one", { _id: item._id });
  if (found?.status === "loading") return null;
  const close = () => go(item.back);
  if (found && !found.value) return <Dialog open onClose={close} title="No such customer" />;
  const { timeZone, day } = formatsOf(ctx.resources);
  return (
    <CustomerForm
      customer={found?.value ?? undefined}
      today={todayIn(timeZone)}
      dayFormat={day}
      // A plain save: the collection, as whoever's at the screen.
      save={(input) =>
        fresh
          ? ctx.db.collection<Customer>("customer").insertOne(input)
          : ctx.db.collection<Customer>("customer").updateOne({ _id: item._id }, input)}
      close={close}
      // A View inside this one: its own reads, live on its own.
      visits={fresh ? null : ctx.show("panel:customer_visits", { _id: item._id })}
    />
  );
};
```

```tsx
// plugins/customers/lib/web/customer-form.tsx
import { Button, DatePicker, Dialog, Field, Form, Input, Stack, toast } from "copilotz/web";
import { type ReactNode, useState } from "react";
import type { Customer } from "../../contract.ts";

/** A refusal as a save or `ctx.call` rejects with it: its words, and the field it's about, if any. */
type Refused = { message: string; detail?: { field?: string } };

/**
 * What the form says of a field the schema refuses: the schema names the field, in words for
 * developers; these are the words for people.
 */
const SAYS: Record<string, string> = {
  name: "Give the customer's name.",
  email: "That email address isn't complete.",
  since: "Give the day they first came.",
};

/** The customer's form: a React component, so it keeps what's typed (a View can't). */
export function CustomerForm({ customer, today, dayFormat, save, close, visits }: {
  customer?: Customer;
  today: string;
  dayFormat: string;
  save(input: { name: string; phone: string; email: string; since: string }): Promise<unknown>;
  close(): void;
  visits: ReactNode;
}): ReactNode {
  const [since, setSince] = useState(customer?.since ?? today);
  const [refused, setRefused] = useState<Refused>();
  const errorOf = (field: string) =>
    refused?.detail?.field === field ? SAYS[field] ?? refused.message : undefined;
  return (
    <Dialog
      open
      onClose={close}
      title={customer ? customer.name : "New customer"}
      placement="top"
      size="lg"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" form="customer" variant="primary">Save</Button>
        </>
      }
    >
      <Stack gap="lg">
        <Form
          id="customer"
          onSubmit={async (_values, form) => {
            const typed = new FormData(form);
            const text = (name: string) => String(typed.get(name) ?? "");
            setRefused(undefined);
            try {
              await save({ name: text("name"), phone: text("phone"), email: text("email"), since });
            } catch (error) {
              // A refusal about one field goes under it; any other, the form says at its top.
              if (!(error as Refused).detail?.field) throw error;
              setRefused(error as Refused);
              return;
            }
            toast("Customer saved.", "success");
            close();
          }}
        >
          <Field layout="row" label="Name" required error={errorOf("name")}>
            {(control) => <Input {...control} name="name" defaultValue={customer?.name} required />}
          </Field>
          <Field layout="row" label="Phone" htmlFor="phone">
            <Input id="phone" name="phone" type="tel" defaultValue={customer?.phone} />
          </Field>
          <Field layout="row" label="Email" error={errorOf("email")}>
            {(control) => (
              <Input
                {...control}
                name="email"
                type="email"
                icon="mail"
                defaultValue={customer?.email}
              />
            )}
          </Field>
          <Field layout="row" label="Customer since" htmlFor="since">
            <DatePicker
              id="since"
              value={since}
              onChange={setSince}
              today={today}
              format={dayFormat}
              max={today}
            />
          </Field>
        </Form>
        {visits}
      </Stack>
    </Dialog>
  );
}
```

Where its errors come from:

- **The browser's own checks** run first: `required`, `type="email"`.
- **The collection schema checks the save** for every caller. When it refuses a field, the error
  names it in `detail.field`. The customer form catches the error and passes a message to that
  `Field`'s `error`. A `Field` whose child is a function of its control
  (`{(control) => <Input {...control} />}`) ties the error to the field for screen readers too
  (`aria-invalid`, `aria-describedby`).
- **A form that calls an Action** can also receive a public `failure` from the Action. When
  `onSubmit` throws, `Form` shows the message at its top as an alert.

The dialog closes and shows a `toast` after the save succeeds. A row `Field` (`layout="row"`) puts
its label in a column beside its control: `labelWidth` and `controlWidth` are each a share of the
whole row (`"33.33%"` and `"66.67%"` fill it). The footer's Save button submits the form by its id
(`form="customer"`), since a dialog's footer is outside it.

## A View inside a View

The customer's dialog shows their last visits. Those are the visits plugin's, so it's the visits
plugin's View, shown by name: customers never imports visits' code, and `ctx.show` gives `undefined`
when no plugin has that View.

```tsx
// plugins/visits/views/web/customer-visits-panel.tsx
import type { ViewContext } from "copilotz";
import { Card, formatDayTime, ListGroup } from "copilotz/web";
import type { ReactNode } from "react";
import { formatsOf } from "../../../look/contract.ts";
import type { Visit } from "../../contract.ts";

/** `panel:customer_visits`: a customer's last visits, a part of whichever View shows it. */
export const customerVisitsPanel = (
  item: { _id: string },
  ctx: ViewContext<ReactNode>,
): ReactNode => {
  const visits =
    ctx.db.collection("visit").query<Visit[]>("ofCustomer", { customer: item._id }).value ?? [];
  const { dayTime } = formatsOf(ctx.resources);
  return (
    <Card title="Last visits" icon="note" padding="none">
      <ListGroup
        flush
        items={visits.map((v) => ({
          href: `/visits/${v._id}`,
          label: v.service,
          description: formatDayTime(v.at, dayTime),
        }))}
      />
    </Card>
  );
};
```

```tsx
// plugins/visits/web.tsx
import { definePlugin, type Plugin } from "copilotz";
import { customerVisitsPanel } from "./views/web/customer-visits-panel.tsx";
import { invoiceScreen } from "./views/web/invoice-screen.tsx";
import { visitDialog } from "./views/web/visit-dialog.tsx";
import { visitsScreen } from "./views/web/visits-screen.tsx";

/** Visits' web front end: each View is a file of web/; this only names them. */
export const visitsWeb: Plugin = definePlugin({
  name: "visits-web",
  views: {
    "screen:visits": visitsScreen,
    "dialog:visit": visitDialog,
    "screen:invoice": invoiceScreen,
    "panel:customer_visits": customerVisitsPanel,
  },
});
```

- **`ctx.show` belongs in a View's body**, with its reads. What it returns is a part, a React node
  to hand to a component: it reads on its own and redraws on its own. Called later, from a
  component's render, a handler, a table's `render` or `detail`, it throws.
- **Shown later, on demand** (a table's detail row someone opens, a tab not yet chosen):
  `<LazyView kind="panel:customer_visits" item={{ _id }} />`, which observes the View only while
  it's drawn.
- **A part that saves with its parent's form** joins it with `useFormSubmit`, inside a `Form`: see
  [forms with parts](the-web-toolkit.md#forms).

## Dates

Days are `YYYY-MM-DD` and times of day `YYYY-MM-DD HH:mm` or `YYYY-MM-DD HH:mm:ss`: the app's clock
time, with no zone. `todayIn(timeZone)` and `nowIn(timeZone, …)` give today and now in the app's
time zone, and every picker writes and reads in the app's `format` pattern. Never a `Date`'s ISO
string, and never `toLocaleString`, which follow the browser and not the app.

This list has every visit of a range of days in the browser, so the table searches, sorts, pages and
exports them itself, every matching row with `exportAll`:

```ts
// plugins/visits/contract.ts
/** A visit: who came, when (the salon's clock, to the second), for what, and its price in cents. */
export type Visit = {
  _id: string;
  customer: string;
  name: string;
  service: string;
  at: string;
  price: number;
};
```

```ts
// plugins/visits/queries.ts
import { people } from "copilotz";
import type { QueryDef } from "copilotz";
import type { Visit } from "./contract.ts";

/** `visit.between`: the visits of a range of days, the latest first. */
export const between: QueryDef<Visit> = {
  allow: people,
  run: (visits, { from, to }: { from: string; to: string }) =>
    visits.find({ at: { $gte: from, $lte: `${to} 23:59:59` } }, { sort: { at: -1 } }),
};

/** `visit.ofCustomer`: a customer's last five visits. */
export const ofCustomer: QueryDef<Visit> = {
  allow: people,
  run: (visits, { customer }: { customer: string }) =>
    visits.find({ customer }, { sort: { at: -1 }, limit: 5 }),
};

/** `visit.one`: a visit, for its dialog and its invoice. */
export const one: QueryDef<Visit> = {
  allow: people,
  run: (visits, { _id }: { _id: string }) => visits.findOne({ _id }),
};
```

```tsx
// plugins/visits/views/web/visits-screen.tsx
import type { ViewContext } from "copilotz";
import { addDays, go, Page, todayIn } from "copilotz/web";
import type { DateRange, Where } from "copilotz/web";
import type { ReactNode } from "react";
import { formatsOf } from "../../../look/contract.ts";
import type { Visit } from "../../contract.ts";
import { VisitsBoard } from "../../lib/web/visits-board.tsx";

/** `screen:visits`, at `/visits`: the visits in a range of days, and a visit's dialog over them. */
export const visitsScreen = (where: Where, ctx: ViewContext<ReactNode>): ReactNode => {
  const [, open] = where.path.split("/").filter(Boolean);
  const { timeZone, day, dayTime } = formatsOf(ctx.resources);
  const today = todayIn(timeZone);
  const range: DateRange = {
    start: where.query?.from ?? addDays(today, -6),
    end: where.query?.to ?? today,
  };
  // Every visit of the range: the table searches, sorts, pages and exports them in the browser.
  const visits = ctx.db.collection("visit").query<Visit[]>("between", {
    from: range.start,
    to: range.end,
  });
  const query = where.query ? `?${new URLSearchParams(where.query)}` : "";
  return (
    <Page title="Visits" width="lg">
      <VisitsBoard
        visits={visits.value ?? []}
        loading={visits.status === "loading"}
        range={range}
        today={today}
        dayFormat={day}
        dayTimeFormat={dayTime}
        pick={(picked) => go(`/visits?from=${picked.start}&to=${picked.end}`)}
        add={() => go(`/visits/new${query}`)}
      />
      {open ? ctx.show("dialog:visit", { _id: open, back: `/visits${query}` }) : null}
    </Page>
  );
};
```

```tsx
// plugins/visits/lib/web/visits-board.tsx
import {
  Button,
  DataTable,
  DateRangePicker,
  formatDayTime,
  Kbd,
  shortcutLabel,
  Stack,
} from "copilotz/web";
import { Toolbar, useShortcuts } from "copilotz/web";
import type { Column, DateRange } from "copilotz/web";
import type { ReactNode } from "react";
import type { Visit } from "../../contract.ts";

/** The visits list: a component, so it can hold the screen's keyboard shortcuts. */
export function VisitsBoard(
  { visits, loading, range, today, dayFormat, dayTimeFormat, pick, add }: {
    visits: Visit[];
    loading: boolean;
    range: DateRange;
    today: string;
    dayFormat: string;
    dayTimeFormat: string;
    pick(range: DateRange): void;
    add(): void;
  },
): ReactNode {
  useShortcuts({ "Alt+N": add });
  const columns: Column<Visit>[] = [
    { key: "at", title: "When", nowrap: true, text: (v) => formatDayTime(v.at, dayTimeFormat) },
    { key: "name", title: "Customer" },
    { key: "service", title: "Service" },
    {
      key: "price",
      title: "Price",
      numeric: true,
      align: "right",
      text: (v) => (v.price / 100).toFixed(2),
    },
    {
      key: "open",
      title: "",
      label: "Invoice",
      render: (v) => <Button size="xs" href={`/invoice/${v._id}`}>Invoice</Button>,
    },
  ];
  return (
    <Stack gap="lg">
      <Toolbar
        start={
          <Button variant="primary" icon="plus" onClick={add}>
            New visit <Kbd>{shortcutLabel("Alt+N")}</Kbd>
          </Button>
        }
        end={
          <DateRangePicker
            label="Days"
            value={range}
            onChange={pick}
            today={today}
            format={dayFormat}
            presets
          />
        }
      />
      <DataTable
        label="Visits"
        columns={columns}
        rows={visits}
        loading={loading}
        rowKey={(v) => v._id}
        exportName="visits"
        exportAll
      />
    </Stack>
  );
}
```

The visit's form picks a customer from a list it searches, and a day and time:

```tsx
// plugins/visits/views/web/visit-dialog.tsx
import type { ViewContext } from "copilotz";
import { go, nowIn } from "copilotz/web";
import type { PickerOption } from "copilotz/web";
import type { ReactNode } from "react";
import { formatsOf } from "../../../look/contract.ts";
import type { Visit } from "../../contract.ts";
import { VisitForm } from "../../lib/web/visit-form.tsx";

/** `dialog:visit`: a visit's form over the list (`_id` "new" for a new one). */
export const visitDialog = (
  item: { _id: string; back: string },
  ctx: ViewContext<ReactNode>,
): ReactNode => {
  const fresh = item._id === "new";
  const visit = fresh
    ? undefined
    : ctx.db.collection("visit").query<Visit | null>("one", { _id: item._id });
  // Another plugin's query, by name: visits requires customers.
  const customers = ctx.db.collection("customer").query<PickerOption[]>("choices", {});
  if (visit?.status === "loading" || customers.status === "loading") return null;
  const { timeZone, dayTime } = formatsOf(ctx.resources);
  return (
    <VisitForm
      visit={visit?.value ?? undefined}
      customers={customers.value}
      now={nowIn(timeZone, 1, undefined, true)}
      timeZone={timeZone}
      dayTimeFormat={dayTime}
      save={(input) => ctx.call("visit.save", fresh ? input : { ...input, _id: item._id })}
      close={() => go(item.back)}
    />
  );
};
```

```tsx
// plugins/visits/lib/web/visit-form.tsx
import { Button, DateTimePicker, Dialog, Field, Form, Input, Picker, toast } from "copilotz/web";
import type { PickerOption } from "copilotz/web";
import { type ReactNode, useState } from "react";
import type { Visit } from "../../contract.ts";

type Draft = { customer?: string; service: string; at: string; price: string };

export function VisitForm({ visit, customers, now, timeZone, dayTimeFormat, save, close }: {
  visit?: Visit;
  customers: PickerOption[];
  now: string;
  timeZone: string;
  dayTimeFormat: string;
  save(input: { customer: string; service: string; at: string; price: string }): Promise<unknown>;
  close(): void;
}): ReactNode {
  const [draft, setDraft] = useState<Draft>({
    customer: visit?.customer,
    service: visit?.service ?? "",
    at: visit?.at ?? now, // `YYYY-MM-DD HH:mm:ss`: its seconds stay until its time is changed
    price: visit ? (visit.price / 100).toFixed(2) : "",
  });
  const set = (change: Partial<Draft>) => setDraft({ ...draft, ...change });
  return (
    <Dialog
      open
      onClose={close}
      title={visit ? "Visit" : "New visit"}
      placement="top"
      footer={<Button type="submit" form="visit" variant="primary">Save</Button>}
    >
      <Form
        id="visit"
        onSubmit={async () => {
          // The Action checks it all again, and its refusal's words show at the form's top.
          await save({
            customer: draft.customer ?? "",
            service: draft.service,
            at: draft.at,
            price: draft.price,
          });
          toast("Visit saved.", "success");
          close();
        }}
      >
        <Field layout="row" label="Customer" htmlFor="customer" required>
          <Picker
            id="customer"
            label="Customer"
            search
            value={draft.customer}
            options={customers}
            onChange={(customer) => set({ customer })}
          />
        </Field>
        <Field layout="row" label="Service" htmlFor="service" required>
          <Input
            id="service"
            value={draft.service}
            onChange={(e) => set({ service: e.target.value })}
            required
          />
        </Field>
        <Field layout="row" label="When" htmlFor="at" required>
          <DateTimePicker
            id="at"
            value={draft.at}
            onChange={(at) => set({ at })}
            timeZone={timeZone}
            format={dayTimeFormat}
            minuteStep={5}
            seconds
          />
        </Field>
        <Field layout="row" label="Price" htmlFor="price" controlWidth="160px">
          <Input
            id="price"
            inputMode="decimal"
            value={draft.price}
            onChange={(e) => set({ price: e.target.value })}
          />
        </Field>
      </Form>
    </Dialog>
  );
}
```

A visit is more than a save, so it keeps an Action: it checks the customer is there, copies their
name onto the visit (a field the server sets, which a browser's View can't), and turns the price
into cents. A record whose fields the server sets (who made it, when, a number in a sequence) keeps
its Action the same way.

```ts
// plugins/visits/actions/save.ts
import { defineAction, failure, people } from "copilotz";

const refuse = (message: string) => failure("invalid", message, { public: true });

/** Adds or changes a visit. Every check is here, whoever calls: the form only helps. */
export const save = defineAction({
  input: {
    type: "object",
    properties: {
      _id: { type: "string" },
      customer: { type: "string" },
      service: { type: "string" },
      at: { type: "string" },
      price: { type: "string" },
    },
    required: ["customer", "service", "at", "price"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, { _id, customer, service, at, price }) => {
    const who = await ctx.db.collection<{ name: string }>("customer").findOne({ _id: customer });
    if (!who) throw refuse("Choose the customer.");
    if (!service.trim()) throw refuse("Say what the visit was for.");
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(at)) {
      throw refuse("Give the visit's day and time.");
    }
    if (!/^\d+(\.\d{1,2})?$/.test(price)) {
      throw refuse("Give the price as a number, such as 25.50.");
    }
    const [units, hundredths = ""] = price.split(".");
    const fields = {
      customer,
      name: who.name,
      service: service.trim(),
      at,
      price: Number(units) * 100 + Number(hundredths.padEnd(2, "0")),
    };
    const visits = ctx.db.collection("visit");
    if (_id) {
      await visits.updateOne({ _id }, { $set: fields });
      return { visit: _id };
    }
    const { insertedId } = await visits.insertOne(fields);
    return { visit: insertedId };
  },
});
```

```ts
// plugins/visits/mod.ts
import { definePlugin, type Plugin } from "copilotz";
import { save } from "./actions/save.ts";
import { between, ofCustomer, one } from "./queries.ts";

export const visits: Plugin = definePlugin({
  name: "visits",
  requires: ["customers"],
  collections: {
    visit: {
      schema: {
        type: "object",
        properties: {
          customer: { type: "string" },
          name: { type: "string" },
          service: { type: "string" },
          at: { type: "string" },
          price: { type: "integer" },
        },
        required: ["customer", "name", "service", "at", "price"],
      },
      indexes: [["customer"], ["at"]],
      queries: { between, ofCustomer, one },
    },
  },
  actions: { "visit.save": save },
});
```

- **`DatePicker`** picks a day; **`DateRangePicker`** a range, with presets (`presets`, or
  `rangePresets(today, { keys, fiscalYearStart, min, max })`) and the range's From and To typed over
  its months. Give `format` as a pattern where people type: a function can't be read back.
- **`DateTimePicker`** picks a day and a time. A stored value's seconds stay until its time is
  changed, so saving a record unchanged keeps them; `seconds` shows them in a field of their own,
  and the value then always has them.
- **`DateRangePicker` with `time`** gives each end a time (`00:00` to `23:59` for a preset). A
  stored time with seconds sorts after its minute, so compare it with an end to the minute:
  `at.slice(0, 16) <= range.end`.
- **`DateRangePicker` with `seconds`** takes each end to the second (`00:00:00` to `23:59:59` for a
  preset), typed whole in From and To and read back by the pattern it's shown in
  ([date ranges with seconds](the-web-toolkit.md#date-ranges-with-seconds)).
- **Days compare as text** in the store (`$gte`, `$lte`), since `YYYY-MM-DD` sorts as it reads.

## Sign-in

Signing in is Copilotz's own page, in the app's look and words: `passwordSignIn` for staff who sign
in with a username (in `app.ts` above), `emailSignIn` for people with an address. The page takes the
theme (`theme: themeOf([look])` on the server), and its words (`words`, by the keys of
`SIGN_IN_WORDS`) and the pitch beside its form (`about`) from the `signInPage` resource of the
browser's plugins (the look's). Staff accounts are made by an Action of the app's that calls
`password.set`, for whoever it lets manage staff: see
[signing in](serving-on-the-web.md#signing-in).

Don't write a sign-in route or a session cookie of your own. A page someone sees before signing in
(a notice, an operator's import) is a route's page, `routePage` from `copilotz/web/server`, laid out
as a `Screen`: it centres a card in the window and keeps a footer at its foot (see
[a page that is the whole window](the-web-toolkit.md#laying-out-a-screen)). No script runs there:
its links and forms that post are what work.

## A printed document

An invoice, a receipt or a ticket is a screen like any other, at its own address, and the browser
prints it:

```tsx
// plugins/visits/views/web/invoice-screen.tsx
import type { ViewContext } from "copilotz";
import {
  Barcode,
  Button,
  DetailList,
  formatDayTime,
  NoPrint,
  Page,
  PrintOnly,
  Stack,
  Text,
} from "copilotz/web";
import type { Where } from "copilotz/web";
import type { ReactNode } from "react";
import { formatsOf } from "../../../look/contract.ts";
import type { Visit } from "../../contract.ts";

/** A printed invoice's own layout: the one place an app writes CSS, and only for paper. */
const PAPER = "@media print { @page { size: 80mm auto; margin: 4mm; } }";

/** `screen:invoice`, at `/invoice/<visit>`: the visit's invoice, to print. */
export const invoiceScreen = (where: Where, ctx: ViewContext<ReactNode>): ReactNode => {
  const [, id] = where.path.split("/").filter(Boolean);
  const visit = ctx.db.collection("visit").query<Visit | null>("one", { _id: id ?? "" });
  if (visit.status === "loading") return null;
  if (!visit.value) return <Page title="No such visit">{null}</Page>;
  const v = visit.value;
  const { dayTime } = formatsOf(ctx.resources);
  return (
    <Page
      title={`Invoice ${v._id}`}
      actions={
        <NoPrint>
          <Button icon="file" onClick={() => print()}>Print</Button>
        </NoPrint>
      }
    >
      <style href="invoice-paper" precedence="default">{PAPER}</style>
      <Stack gap="md">
        <PrintOnly>
          <Text weight="bold" align="center">The salon</Text>
        </PrintOnly>
        <DetailList
          item={{
            When: formatDayTime(v.at, dayTime),
            Customer: v.name,
            Service: v.service,
            Total: (v.price / 100).toFixed(2),
          }}
        />
        <Barcode value={`VISIT ${v._id}`} caption height={48} />
      </Stack>
    </Page>
  );
};
```

- A printed page leaves out the frame's bars, buttons, toasts and a `Page`'s header (`printHeader`
  keeps it). `NoPrint` marks more of the screen to leave out, and `PrintOnly` what only paper shows.
- `Barcode` draws Code 128, black on white.
- The paper's own layout (a receipt's width, an invoice's margins) is the one place an app writes
  CSS: `@media print` rules, beside the document. Nothing else.
- The same document as a PDF on a server (to e-mail it) is `documentPdf` from `copilotz/web/export`:
  see [PDFs on a server](the-web-toolkit.md#pdfs-on-a-server).

## Keyboard shortcuts

A screen's keys are `useShortcuts` in one of its components (the visits board above:
`{ "Alt+N": add }`), bound while the screen is shown. A key waits while someone types in a field,
unless it says `inFields`, and while a dialog or a popover is open over the screen, unless the
screen is in it (`within`). `shortcutLabel("Alt+N")` writes it as the keyboard does, in a `Kbd`.
Don't add `keydown` listeners to the document.

## Files and pictures

`FileInput` is the field: the browser's file field drawn as the toolkit's, with its own words
(`chooseLabel`, `changeLabel`, `removeLabel`), a file already stored (`current`, removed by
`onRemove`), and files dropped on it. A picture chosen but not yet sent shows in an `Avatar` from a
`blob:` address (`URL.createObjectURL`), with `initial={false}` for an empty box when there's none.
Sending it is the Action's: the form reads the file as a `data:` address and passes it in the input.

The picture is private (only trusted code reads or writes it, and no event holds it), so a service
is saved by an Action, which outsiders' writes, a View's included, can't do.

```ts
// plugins/services/actions/save.ts
import { defineAction, failure, people } from "copilotz";

/** A picture as the form sends it: a PNG, JPEG or WebP `data:` address, 1 MB or so at most. */
const PICTURE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

export const save = defineAction({
  input: {
    type: "object",
    properties: {
      _id: { type: "string" },
      name: { type: "string" },
      // `null` takes the picture away; left out, it stays as it is.
      picture: { type: ["string", "null"], maxLength: 1_400_000 },
    },
    required: ["name"],
    additionalProperties: false,
  },
  // The picture is kept in the service, not again in the call's record.
  private: ["picture"],
  allow: people,
  run: async (ctx, { _id, name, picture }) => {
    if (!name.trim()) throw failure("invalid", "Give the service a name.", { public: true });
    if (picture && !PICTURE.test(picture)) {
      throw failure("invalid", "The picture must be a PNG, JPEG or WebP image.", { public: true });
    }
    const services = ctx.db.collection("service");
    const fields = { name: name.trim(), ...(picture !== undefined ? { picture } : {}) };
    if (_id) {
      await services.updateOne({ _id }, { $set: fields });
      return { service: _id };
    }
    const { insertedId } = await services.insertOne(fields);
    return { service: insertedId };
  },
});
```

```tsx
// plugins/services/lib/web/service-form.tsx
import { Avatar, Button, Dialog, Field, FileInput, Form, Input, Stack, toast } from "copilotz/web";
import { type ReactNode, useEffect, useState } from "react";

type Service = { _id: string; name: string; picture?: string };

/** A file as a `data:` address, for an Action's input. */
const dataOf = (file: File) =>
  new Promise<string>((done, failed) => {
    const reader = new FileReader();
    reader.onload = () => done(String(reader.result));
    reader.onerror = () => failed(reader.error);
    reader.readAsDataURL(file);
  });

export function ServiceForm({ service, save, close }: {
  service?: Service;
  save(input: { name: string; picture?: string | null }): Promise<unknown>;
  close(): void;
}): ReactNode {
  const [file, setFile] = useState<File>();
  const [removed, setRemoved] = useState(false);
  // A picture chosen but not yet sent shows from a `blob:` address, let go once it's replaced.
  const [preview, setPreview] = useState<string>();
  useEffect(() => {
    if (!file) return setPreview(undefined);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const shown = preview ?? (removed ? undefined : service?.picture);
  return (
    <Dialog
      open
      onClose={close}
      title={service ? service.name : "New service"}
      placement="top"
      footer={<Button type="submit" form="service" variant="primary">Save</Button>}
    >
      <Form
        id="service"
        onSubmit={async (_values, form) => {
          const name = String(new FormData(form).get("name") ?? "");
          const picture = file ? await dataOf(file) : removed ? null : undefined;
          await save({ name, ...(picture !== undefined ? { picture } : {}) });
          toast("Service saved.", "success");
          close();
        }}
      >
        <Field layout="row" label="Name" htmlFor="name" required>
          <Input id="name" name="name" defaultValue={service?.name} required />
        </Field>
        <Field layout="row" label="Picture" htmlFor="picture">
          <Stack gap="sm">
            <FileInput
              id="picture"
              accept="image/png,image/jpeg,image/webp"
              chooseLabel="Choose a picture"
              changeLabel="Change picture"
              removeLabel="Remove picture"
              current={service?.picture && !removed ? "Current picture" : undefined}
              onChange={(files) => setFile(files[0])}
              onRemove={() => {
                setFile(undefined);
                setRemoved(true);
              }}
            />
            <Avatar
              name={service?.name ?? "New service"}
              picture={shown}
              initial={false}
              size={64}
            />
          </Stack>
        </Field>
      </Form>
    </Dialog>
  );
}
```

- **The file field comes first** in the control's column, the preview under it: a row `Field`'s
  label lines up with the first line of text beside it.
- **`private: ["picture"]`** keeps the picture out of the call's record: its `action.started` holds
  the rest of the input. The service keeps it, and so does the record of the service's changes: a
  string over 16 KiB is a blob, stored once by the hash of its content, and the document and each of
  its events hold a small reference to it. Reads load it whole.
- **A picture replaced or taken away isn't erased.** Nothing deletes a blob: it stays where blobs
  live, and the service's earlier events still refer to it.
- **A file to import** (a CSV of customers) is read in the browser, its rows checked and sent to one
  Action that saves them in one `ctx.transaction`.

### Pictures in a list

A list reads names, not pictures. Its query leaves the picture out, so no blob is even read, and
each row shows the picture from a route of the plugin's, which checks who asks, then reads it with
`runtime.bytes`:

```ts
// plugins/services/queries.ts
import { people } from "copilotz";
import type { QueryDef } from "copilotz";

type Service = { _id: string; name: string; picture?: string };

/** `service.list`: every service, its picture left out. */
export const list: QueryDef<Service> = {
  allow: people,
  run: (services) => services.find({}, { sort: { name: 1 }, projection: { picture: 0 } }),
};
```

```ts
// plugins/services/routes.ts
import { people, type Route } from "copilotz";

/** A picture as the Action keeps it: a PNG, JPEG, GIF or WebP `data:` address. */
const PICTURE = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/;

/** `GET /pictures/<id>`: a service's picture, to whom the list's query lets in. */
export const picture: Route = async (_request, { runtime, actor, params }) => {
  const none = new Response("Not found", { status: 404 });
  if (!people(actor)) return none;
  // No rule speaks for "service", so it's read as the system, now the route has let them in.
  const kept = await runtime.bytes("service", { _id: params.id }, "picture");
  if (!kept) return none;
  const text = new TextDecoder().decode(await kept.read(0, kept.size));
  const [, type, base64] = PICTURE.exec(text) ?? [];
  if (!base64) return none;
  const body = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new Response(body, {
    headers: {
      "content-type": type,
      // Never read as anything but the image it says it is.
      "x-content-type-options": "nosniff",
      // A changed picture keeps its address: the browser asks again, and nothing shared keeps it.
      "cache-control": "private, no-cache",
    },
  });
};
```

```ts
// plugins/services/mod.ts
import { definePlugin, type Plugin } from "copilotz";
import { save } from "./actions/save.ts";
import { list } from "./queries.ts";
import { picture } from "./routes.ts";

export const services: Plugin = definePlugin({
  name: "services",
  collections: {
    service: {
      schema: {
        type: "object",
        properties: { name: { type: "string" }, picture: { type: "string" } },
        required: ["name"],
      },
      queries: { list },
    },
  },
  actions: { "service.save": save },
  routes: { "/pictures/:id": picture },
});
```

```tsx
// plugins/services/views/web/services-screen.tsx
import type { ViewContext } from "copilotz";
import { Avatar, DataTable, Page } from "copilotz/web";
import type { Column, Where } from "copilotz/web";
import type { ReactNode } from "react";

/** A service as the list reads it: no picture. */
type Listed = { _id: string; name: string };

const columns: Column<Listed>[] = [
  {
    key: "picture",
    title: "",
    label: "Picture",
    // Fetched as any image is: the initial shows until it loads, and when there's none.
    render: (s) => <Avatar name={s.name} picture={`/pictures/${s._id}`} size={32} />,
  },
  { key: "name", title: "Name" },
];

/** `screen:services`, at `/services`: every service, with its picture. */
export const servicesScreen = (_where: Where, ctx: ViewContext<ReactNode>): ReactNode => {
  const found = ctx.db.collection("service").query<Listed[]>("list", {});
  return (
    <Page title="Services" width="lg">
      <DataTable
        label="Services"
        columns={columns}
        rows={found.value ?? []}
        loading={found.status === "loading"}
        rowKey={(s) => s._id}
      />
    </Page>
  );
};
```

- **Check who asks before reading.** A route is trusted code: it decides who gets in, as a query's
  `allow` does. `runtime.bytes` with `{ actor }` then reads under the rules, and only a collection a
  rule speaks for (`shared`, a `guard`): elsewhere it's refused (`forbidden`), since no rule would
  narrow what they reach. `service` has none, so the route reads it as the system once `people` let
  them in, as the list's query reads it for them. A collection in `shared` is read as the actor
  instead, so the rules decide which of its documents they reach (out of reach: none, a 404).
- **`Avatar`** takes a path on the app's own origin, and the browser sends the session's cookie with
  it. A picture that fails to load (none, or out of reach: a 404 alike) shows the initial.
- **A file of more than a few MB** (a PDF, a scan) goes in a call of its own, since a call carries
  at most 16 MiB, and is better kept as plain base64 beside its name and type, then streamed:
  `kept.read(start, end)` hands over a part at a time (the owner loads the blob once), and each four
  base64 characters decode on their own. Chat does so: `chat.attach` takes one file a call,
  unrecorded, and `/files/<id>` streams it, with ranges.

## When the toolkit lacks something

Compose the toolkit's pieces first: `Grid` and `Stack` place anything, `Card` and `ListGroup` make
panels and lists, `RowsEditor` edits repeating rows, `Picker search` is a choice from a long list,
`Split` sets a main column beside a summary, `Tabs` and `Menu` the rest. What several screens share
is a component of the app's own in `lib/`, made of those pieces
([shared UI](#shared-ui-an-apps-own-components)). If a screen still needs what no piece or token
does, it's a gap: say what's missing in the smallest example, and keep the screen to the toolkit
until it's there. Don't restyle the toolkit (a stylesheet of the app's own, overrides of
`.copilotz-*` classes), or copy a workaround written for an older release without checking this one:
rc.54 has `Screen`, typed range ends, seconds in day-times, `hidden` on layout pieces, fields that
fit table cells, `detailOpen`, `Toolbar grow`, a file field's own words and previews.

## Related

- [The web toolkit](the-web-toolkit.md): every piece, prop and token.
- [Serving on the web](serving-on-the-web.md): the page, routes, sign-in and its words.
- [Getting Started, chapter 3](../getting-started/03-its-own-web-page.md): a React View, tested by
  pressing its buttons.
- [Views](../architecture/views.md): how Views run, and parts.
