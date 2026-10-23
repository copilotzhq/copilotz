# Create Thread Message Action

## What it is

The canonical atomic write for a Core Message, its sender, and optional selected
participants.

## Why it exists

Content materialization, Participant creation, Message creation, and membership
must not partially commit.

## How to use it

Invoke `createThreadMessage` with a deterministic Message ID, Thread, sender,
recipients, and content.

To enroll participants with the message, supply `membership.participants` as
Participant inputs with unique external IDs. `membership.recipients` is an
ordered list of `{ externalId }` references to those inputs or
`{ participantId }` references to existing participants. Membership determines
who belongs to the Thread; recipients determine who responds. Ordinary calls
using canonical `recipientIds` remain supported.

A message that names no recipients (neither `recipientIds` nor
`membership.recipients`) addresses the Thread's agent participants other than
the sender, so a chat composer reaches the conversation's agents without
choosing one. Explicit recipients always win, and an explicit empty list
addresses no one, which is how agent replies and system notices avoid waking
other agents. A Thread without agents leaves the message unaddressed.
`threadAgentRecipients` is that default, shared with channel ingress.

## How it works

It prepares content, resolves the sender, and applies all Collection mutations
in one transaction with routing and visibility metadata.

A membership batch uses one keyed Thread command, including a recorded no-op
when everyone already belongs. Replaying that command does not re-add members
removed later. Participant creation, membership, and the Message roll back
together if the transaction fails.
