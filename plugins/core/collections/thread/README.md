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

## How it works

The schema indexes external and parent IDs and commands update membership and
lifecycle state.
