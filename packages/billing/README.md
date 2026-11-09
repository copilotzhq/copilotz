# @copilotz/billing

What an org has to spend, and paying for it, for [Copilotz](https://github.com/copilotzhq/copilotz):
plans, credits and budgets on Copilotz's usage ledger, and Stripe as one way to pay.

```sh
npm install @copilotz/billing copilotz          # Node 24+, Bun
deno add jsr:@copilotz/billing jsr:@copilotz/copilotz
```

It goes with Copilotz at the same version (they're released together): `@copilotz/billing@x.y.z`
with `copilotz@x.y.z`.

```ts
import { usage } from "copilotz/plugins/billing";
import { credits, stripe, stripeWebhook } from "@copilotz/billing";

const runtime = await createRuntime({
  store,
  plugins: [models, chat, ...access, usage, credits, stripe, stripeWebhook, app],
});
```

```ts
// In the browser: the org page's Billing, and the note above where you type.
import { creditsWeb } from "@copilotz/billing/web";
```

| Import                       | What it has                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `@copilotz/billing`          | `credits`, `stripe`, `stripeWebhook`                                                 |
| `@copilotz/billing/web`      | `creditsWeb`                                                                         |
| `@copilotz/billing/contract` | what a way of paying tells `billing.apply` (`PaymentFact`…), a plan's terms, `unfit` |

- **`credits`**: the org pays. Its plan (`billingPlan`), credits (`credit`) and payments (`payment`)
  are its own rows; a plan's terms are data, so a contract is a record, not code. Its balance is its
  credits less what the ledger charged since its plan began, and the check (`billing.check`, named
  by the `spending` resource that whatever spends reads) stops it at its limit. Staff change plans,
  give credits, waive and record payments by hand; a provider's webhook calls `billing.apply`. The
  ledger itself, `usage`, stays Copilotz's (`copilotz/plugins/billing`): metering every use is.
- **`stripe`**: Checkout and the customer portal are Stripe's pages, so no card reaches the app;
  what was paid lands by a signed webhook (`stripeWebhook`, `POST /__stripe/<seller>`, in the
  runtime of the app's one address: the directory's, with many orgs).

Through 1.0.0-rc.32 these were `credits`, `stripe` and `stripeWebhook` in
`copilotz/plugins/billing`, and `creditsWeb` in `copilotz/plugins/billing/web`. Their names
(collections, Actions, events, Views, routes, resources) are the same, so an app's data stays as it
is: only its imports change. See
[design/plugins.md](https://github.com/copilotzhq/copilotz/blob/main/design/plugins.md).
