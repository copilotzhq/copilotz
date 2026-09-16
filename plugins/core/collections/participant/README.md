# Participant Collection

## What it is

The canonical record of human, agent, Tool, and job participants.

## Why it exists

Threads and Messages need stable identities independent from external IDs.

## How to use it

Access the `participant` scoped Collection or its `byExternalId` query.

## How it works

The schema stores identity, presentation, metadata, and timestamps with an
external-ID index.
