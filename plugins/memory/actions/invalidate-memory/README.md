# Invalidate memory

## What it is

The narrow Action `copilotz.memory.invalidate` for editorial maintenance of one
semantic-memory record.

## Why it exists

A record can need retraction, supersession, or archival while the lifecycle of
the fact, intent, occurrence, or procedure it describes remains true.

## How to use it

Expose it through the `invalidate_memory` memory tool to an agent with a
concrete, evidence-backed maintenance need.

## How it works

It permits writes only to memory spaces writable from the calling thread,
preserves `status`, records validity and trusted trigger-message provenance, and
atomically writes a supersession relation when applicable. Identical retries are
no-ops; conflicting dispositions are rejected.
