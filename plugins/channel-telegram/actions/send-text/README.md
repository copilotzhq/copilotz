# Telegram send-text Action

## What it is

An explicitly invoked, owner-backed Action for one ordinary JSON text request.
It accepts `deliveryKey`, the configured `channelId`, `chatId`, and `text` (at
most 4,000 characters). Use the existing stable delivery key in the Action's
`operationKey`; changing invocation identity creates a different logical effect.

## Why it exists

The existing channel egress Processor calls adapters directly. A stable delivery
key alone cannot prevent an ambiguous external send from being repeated. This
Action puts one Telegram request behind the owner's effect protocol.

## How to use it

The currently tested owner composition registers the standalone
`telegramSendTextAction` under the `telegramSendText` alias, with an
external-egress channel resource and the existing
`adapters.channelProviders[channelId]` config/transport. Invoke that Action only
through the owner-backed execution path. The complete `telegramChannelPlugin`
inherits core content and deferred-Action capabilities that the current fresh
owner host still refuses; full plugin activation awaits those conversions.
Missing effect authority fails before any provider request. Credentials stay in
the prebound adapter; protected-slot hydration is separate unfinished
integration.

## How it works

A fresh `effect.begin("telegram.sendText")` is the only permission to send.
Confirmation stores just `{ deliveryKey, providerId }`; a confirmed retry
returns that reference without contacting Telegram. A lost provider response,
provider failure, or malformed provider response leaves the effect begun and
fails with `effect_indeterminate`. Unknown owner begin/confirm acknowledgements
propagate unchanged: the command may have committed, including a confirmation.
Current authorized effect state and receipts decide recovery; a lost owner
acknowledgement never grants another send. The current provider transport has no
authoritative lookup, so reconciliation of a begun effect refuses to resend. No
HTTP error or network exception is treated as proof of non-execution. A
configuration/preflight error after begin also leaves the step begun; it cannot
reopen it without owner-verified no-start evidence. Cancellation is passed to
the provider request; custom transports must cooperate with that signal.

This first path refuses transforms and does not implement media, multipart
messages, uploads, ContentRef/View resolution, or automatic egress routing. The
legacy channel Processor and its retry behavior remain unchanged until their
coherent owner-backed conversion. The tests use an injected fetch and actual
owner receipts; they never contact Telegram or certify provider idempotency.

The source fixture also does not certify a database-free deployable provider
artifact. Existing public plugin barrels still reach host implementation
modules; role-specific build resolution and its emitted-closure proof remain a
separate package gate.

## Actual transport proof

`transport.integration.test.ts` uses the real owner host, registered Action
worker, ingress connection, owner receipts, and explicit unpublished Oxian
sibling over both in-process and WebSocket transports. Provider fetch remains
injected. With a capacity-one worker, a duplicate does not send again and the
next distinct Action succeeds on the same connection.

The fault cases disconnect that worker after a known owner command commit but
before the reply reaches it. Lost begin acknowledgements send nothing. Another
case disconnects after injected provider acceptance but before its response
reaches the Action: it retains the begun receipt and one request, without
inferring `not_started`. Lost confirm acknowledgements retain confirmation and
one provider request; lost terminal acknowledgements retain the completed
lifecycle and one request. The retired connection cannot complete or send later,
and all cases retain the three-attempt delivery policy. These are transport-loss
tests, not uncertain database-COMMIT tests.

The fresh-only host currently stops after an opened-work transport failure, even
when the terminal command committed. The tests assert bounded refusal, preserved
durable obligations, and no resend; result/receipt recovery and continued
service after that disconnect remain host-recovery work. Direct fixture database
inspection is not evidence of an authorized recovery route. The tests are opt-in
through `COPILOTZ_OXIAN_SOURCE_ROOT` and the same ephemeral source-mapping
config prepared by `scripts/test-owner-connected.mjs`; they do not change
published dependency pins.
