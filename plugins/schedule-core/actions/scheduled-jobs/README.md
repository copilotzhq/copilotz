# Scheduled Jobs Action

## What it is

The executable Action behind the `scheduled_jobs` Tool Resource.

## Why it exists

Agent-visible Tool presentation and durable scheduled-job execution have
separate runtime responsibilities.

## How to use it

Compose `coreSchedulesPlugin` and grant the `scheduled_jobs` Tool to an Agent.
For `create` and recipient updates, `run.recipients` accepts `"caller"`,
`"all"`, or a non-empty list of participant/Agent identities. It defaults to the
trusted calling Agent on creation. An omitted recipient update preserves the
job's existing recipients.

## How it works

The Action validates the requested operation and delegates to the generic
Schedules commands while enforcing the Core scheduled-message payload shape. It
snapshots every recipient to canonical identities when the job is authored;
scheduled execution never silently broadcasts to thread participants.
