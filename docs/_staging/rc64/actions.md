# Actions and test mail

## CHANGELOG entry for Unreleased

- **Actions take their input type from the schema.** Omit `input` for an Action that takes nothing.
  Its callers can omit the argument or pass `{}`. Extra fields fail validation.
- **A plugin can say who may call its Actions and queries once**, with
  `defaults: { allow: people }`. Each may set its own `allow`. An `allow(actor, input, ctx)` can
  await a collection read as the caller, so many Actions can name the same permission check.
- **An Action can declare its grant and its transaction.** `as: "inventory-adjust"` runs its code as
  that grant after admission. Its writes name the grant and who called it. `transaction: true`
  commits the work together or rolls it back, including another transactional Action it calls.
- **Mail in tests.** `captureEmail()` keeps the messages sent by `email.send`, attachments included.
  `clear()` empties the mailbox. The built-in `capture` adapter can also write `.eml` files.

## Exact AGENTS.md text

In “Rules: do this, not that”, replace the bullet starting “Say `allow` on every Action outsiders
call” with the following text, including the example.

> **Say who may call a plugin's Actions and named queries once.** Set `defaults: { allow: people }`
> in `definePlugin` or the fields exported by `plugin.ts`. Each Action or query can override it with
> `allow` (`inPerson` for what only the person decides). Without a rule of its own or a default, the
> Action or query is internal. A rule may be async: `allow(actor, input, ctx)` reads with `ctx.db`
> as the caller, before a grant. An agent and its principal must both pass.
>
> **Give an Action only the declarations it needs.** Omit `input` when it takes no parameters.
> Calling with nothing or `{}` works, and extra fields are refused. With a schema, `run(ctx, input)`
> infers the fields, required and optional, without an annotation. Use `as: "inventory-adjust"` to
> declare a named grant. The writes record the grant `via` the caller. `transaction: true` makes the
> Action open or join one transaction. Its writes roll back on a throw. `atomic: true` alone opts
> into another Action's transaction when called through `tx.call`.
>
> For example, an inventory Action used to check a permission, take a grant and open a transaction
> before issuing a product:
>
> ```ts
> run: async (ctx, { product }) => {
>   await requireInventory(ctx);
>   return ctx.as(grant("inventory-adjust")).transaction((tx) => issueOne(tx.db, product, ctx.in));
> },
> ```
>
> With the same schema and stock rule, its whole declaration can be:
>
> ```ts
> export const issue = defineAction({
>   input,
>   allow: canUse("inventory"),
>   as: "inventory-adjust",
>   transaction: true,
>   run: (ctx, { product }) => issueOne(ctx.db, product, ctx.in),
> });
> ```
>
> If every inventory Action uses that check, move it to the plugin's `defaults.allow`.
> [Actions, including the full stock example](https://copilotz.com/docs/reference.md#actions).

In “Test without an API key: the default loop”, add this paragraph before `tests/kit.ts`.

> **Mail in tests.** Trusted code sends invoices and receipts with
> `ctx.call("email.send", message)`. In a test, import `captureEmail` and `email` from
> `copilotz/plugins/access/email`, make `const inbox = captureEmail()`, register
> `adapters: { email: { capture: inbox } }` and select
> `resources: { email: { adapter: "capture", from: "orders@example.com" } }`. Read `inbox.messages`
> after the send and call `inbox.clear()` to empty it. The exported `mime(message, from).source`
> builds its MIME source.
> [Mail in tests](https://copilotz.com/docs/reference/plugins/email.md#mail-in-tests-the-capture-adapter).

## Capability index

```text
Call an Action that takes nothing → defineAction({ run }) → docs/reference.md#actions-with-no-parameters
Type an Action's parameters from its fields → defineAction({ input, run }) → docs/reference.md#a-grant-and-a-transaction-for-the-whole-action
Share caller rules across a plugin → definePlugin({ defaults: { allow } }) → docs/reference.md#one-permission-check-for-actions-and-queries
Check a person's permission before an Action runs → async allow(actor, input, ctx) → docs/reference.md#one-permission-check-for-actions-and-queries
Record writes under a named grant → defineAction({ as: "inventory-adjust" }) → docs/reference.md#a-grant-and-a-transaction-for-the-whole-action
Run an Action in one transaction → defineAction({ transaction: true }) → docs/reference.md#a-grant-and-a-transaction-for-the-whole-action
Test mail without sending it → captureEmail() → docs/reference/plugins/email.md#mail-in-tests-the-capture-adapter
Open development mail as files → resources.email.capture.directory → docs/build-compass/part-10-testing/31-fakes-at-the-edges.md#mail-in-tests-the-capture-adapter
Send a receipt or build its MIME source → email.send and mime(message, from) → docs/reference/plugins/email.md#mail-in-tests-the-capture-adapter
```
