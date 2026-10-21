# Thread Collection

## What it is

The canonical conversation Thread record.

## Why it exists

Conversation membership, status, ancestry, and active revision state need a
durable owner.

## How to use it

Access the `thread` Collection and its membership commands.

`ensureMembership` unions a sorted, unique array of canonical `participantIds`
with current membership. Use a stable operation key scoped to the send/message
to retain its result even when the command changes nothing. `addParticipant`
remains available for individual enrollment.

`recordMessage { messageId }` records a new visible message as the thread's
activity: it sets `lastMessageId`, which moves `updatedAt`, so lists ordered by
recent activity reorder live. Message creation (`createThreadMessage`, channel
ingress and scheduled delivery) calls it in the same transaction, with an
operation key scoped to the message. It emits `thread.message-recorded`, not
`thread.updated`, so processors of thread changes do not run for every message.
Internal messages do not record activity.

## How it works

The schema indexes external and parent IDs and commands update membership and
lifecycle state.
