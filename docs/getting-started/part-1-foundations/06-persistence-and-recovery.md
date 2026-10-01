---
title: "Ch 6: Persistence and Recovery"
description: "Persist notes and understand durable Processor retries and their limits."
section: Getting Started
order: 60
status: stable
---

# Chapter 6: Persistence and Recovery

> **Part 1 — Foundations**

## The pain

An in-memory application forgets its notes and event history when it closes.
Durable storage fixes that loss, but it also means a process can stop while
follow-up work is still pending.

## The smallest useful change

Choose a database URL in the same `createCopilotz()` options used in Chapter 1.
For local development, PGlite can keep the database in a project directory:

```ts
// Add this property to the createCopilotz() options in assistant.ts.
database: {
  // Keep PGlite records and event history on local disk between runs.
  url: "file://./data",
},
```

For a deployment that supplies PostgreSQL, use its connection URL instead:

```ts
// Add this property when the host provides a PostgreSQL connection URL.
database: {
  // Read the database URL from the process environment.
  url: env.DATABASE_URL!,
},
```

The Node project setup in the guide's start page includes PGlite as a
dependency. Keep the same namespace between runs so the application opens the
same tenant data.

## Breaking it down

Collection mutations and Action lifecycles create immutable Events. Matched
Processors create durable delivery obligations. Delivery is at least once: if a
Worker stops or a retryable failure occurs, a Processor may handle the same
Event again.

That is why Chapter 4 derived the audit record ID and operation key from the
source Event ID. The Collection runtime can restore a settled write for the same
operation identity. A call to an external service is outside that Collection
guarantee; pass a stable idempotency key to that service when it supports one.

By default, a Processor's work participates in the operation that caused it.
Awaiting `turn.done` waits for that in-scope work to settle. Some applications
choose detached background work; it remains durable, but its failure does not
reject the original operation. See
[Events, Deliveries, and Recovery](../../events-deliveries-recovery.md) for the
operational details and recovery boundaries.

## What this unlocks

- Notes and their event history survive application restarts.
- Pending Processor work can resume after a process or Worker stops.
- Stable operation identity makes built-in mutations safe to recover.

## What's next

Your application now has a small agent harness, reusable note data and actions,
event-driven follow-up, and durable storage. Continue with
[Chapter 7: Existing APIs and Tools](../part-2-capabilities/07-existing-apis-and-tools.md)
to connect capabilities the application already owns.
