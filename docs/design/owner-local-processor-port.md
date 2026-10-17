# Private owner-local Processor attempt adapter

This increment joins the existing one-attempt registered Processor driver to the
real owner command boundary. It is internal composition, not public placement
activation or a retry scheduler.

## Boundary and authority

- Construction captures an exact owner-local Processor binding, positive attempt
  ordinal, owner-control and owner-local principals, and synchronous private
  lifetime/receipt hooks. Caller witnesses never enter command intent.
- Start uses `owner.local-processor-start` and its incarnation-scoped key. Only
  a fresh committed receipt for that binding and ordinal admits invocation. A
  duplicate start does not reactivate work.
- Input and cancellation state use `processor.local-input` and
  `processor.local-settlement-state`. Shared strict decoders retain ordinary
  Event identity, metadata shape and lossless retry timestamps.
- Collection calls use the existing neutral Processor key prefix
  `delivery:<deliveryId>:`. The owner must independently call
  `processor.authorizeLocalLive` and supply the resulting private attempt and
  source identity to its Collection handler. The adapter does not authorize a
  write by itself.
- Completion uses `processor.local-complete` with an incarnation key. A
  `retry_wait` receipt ends one attempt; it does not authorize the next attempt.
  Completion errors are never converted into a fabricated noncommit witness.

## Lifetime and capacity

Raw boundary calls occupy bounded slots before they can reenter the adapter.
Sealing closes authored invocation calls, and draining waits for their actual
promises, even after cancellation or revocation. Receipt hooks are also charged
before invocation, so an accidental asynchronous hook cannot make a reentrant
drain report quiescence early. Asynchronous or throwing hooks quarantine the
adapter.

Known start/end receipts are supplied as detached copies to the host before the
final lifetime check. An ended receipt is a recorded fact, not permission to
release capacity immediately. The host must wait for actual driver quiescence,
permanently revoke the predecessor, and retain capacity when the outcome is
unknown. A hook that revokes the entry before the adapter's final current check
will correctly prevent that call from returning success.

## Verification and remaining composition

Tests cover exact references and ordinals, duplicate start refusal, captured
callbacks and methods, bounded/reentrant raw calls, hook snapshot mutation,
sticky revocation, malformed projections/receipts, and microsecond retry times.
Real owner fixtures cover successful execution, retry, exhaustion, unknown
committed completion, actual Collection mutation and deduplicated replay,
unknown committed Collection replies, and current-source denial on receipt
replay. These fixtures use PGlite by default and the explicit test PostgreSQL
connection when supplied.

The [private generation-aware host](owner-host-local-processor.md) now combines
known ended receipts, predecessor revocation and drain, SQL due-time checks,
alarms and shared local/worker capacity, with its own scoped integration
evidence. Local nested Actions, effects, public mixed placement selection and
restart parity remain separate gates. This adapter does not add a heartbeat or
make a database prerequisite for ordinary embedded Copilotz use.
