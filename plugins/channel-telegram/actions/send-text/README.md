# Telegram send-text Action

## What it is

The ordinary `telegramSendText` Action sends one bounded text request. Its input
is `{ deliveryKey, channelId, chatId, text }`, with at most 4,000 characters.
Use a stable Action `operationKey`: a different invocation is a different
effect.

## How to use it

Install `telegramChannelPlugin`, configure an external-egress channel in
`resources.channels`, and bind its credentials and transport under
`adapters.channelProviders[channelId]`. The generated plugin registers the
`telegramSendText` alias. Invoke it through the application's normal Action
handle. The Action context must carry owner-bound effect authority.

## Recovery and cancellation

Only a fresh `effect.begin("telegram.sendText")` returning `proceed` permits
sending. Confirmation retains `{ deliveryKey, providerId }`. A confirmed retry
returns that reference without contacting Telegram. A lost provider response or
malformed response leaves the effect begun and fails `effect_indeterminate`.
Telegram provides no authoritative lookup for this request, so reconciliation
cannot safely resend. HTTP status and network errors never prove `not_started`.
The transport receives the Action's cancellation signal; a custom transport must
honor it. Cancellation does not prove that a provider request never happened.

This text-only Action refuses delivery transforms. Normal channel egress uses
the same protocol through the generic `channelDeliver` Action, including media
and multipart adapter work. If a multipart delivery partially succeeds, the
whole delivery remains indeterminate rather than resending its successful parts.

Tests inject provider fetches and verify the real owner effect records. They do
not contact Telegram or assert that Telegram has provider-side idempotency.
