# Schedule Input Authoring

## What it is

These helpers create typed tick and manual-run application envelopes.

## Why it exists

Hosts need a small, runtime-neutral way to submit schedule work without
constructing internal Event shapes.

## How to use it

Call `scheduleTick(...)` or `runScheduledJobNow(...)`, then pass the envelope to
`application.send(...)`.

## How it works

The helpers separate routing identity from immutable semantic payload data.
