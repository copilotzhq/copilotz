# Durable provider jobs (proposal, not implemented)

Moved from `docs/execution-liveness.md`, which documents only the current public
surface.

A future OpenAI Responses adapter can submit with `background: true`, persist
the response ID, and resume retrieval after a restart. The API supports polling,
cancellation, and cursor-based stream resumption for responses initially created
with streaming. Retention depends on account and `store` settings, so retrieval
availability must be part of the durable-job contract.
[OpenAI background-mode documentation](https://developers.openai.com/api/docs/guides/background).

Proposed implementation:

1. Persist a submission intent under the Action effect key. Submit once, then
   persist the response ID and provider connection identity before yielding the
   delivery. A crash between provider acceptance and saving the ID is still an
   indeterminate submission; do not blindly resubmit or claim exactly-once
   billing without provider reconciliation guarantees.
2. Schedule short, leased polling continuations. Persist status and the next
   poll time. A worker restart resumes the same response ID. Poll success
   establishes provider reachability; queued/in-progress status is not proof of
   new output.
3. Persist terminal output and usage through the existing completion checkpoint,
   then project once. If streaming is needed, persist the last committed
   provider event cursor with the corresponding output append; do not advance it
   merely because an event was received.
4. Keep durable cancellation separate from transport disconnect, and handle
   retention expiry as an explicit unrecoverable job result.

This needs a durable submission/polling state machine and reconciliation tests;
it is not implemented as part of the timeout change.
