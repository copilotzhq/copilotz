# Channel core

## What it is

The shared graph, ingress, and egress runtime used by every concrete channel
provider.

## Why it exists

It gives providers one durable mapping from their external threads to Copilotz
threads.

## How to use it

Compose `channelsPlugin`, then add a provider plugin and channel
resource/adapter under the same alias.

## How it works

Ingress records a binding and message atomically; egress prepares a durable
intent and a detached processor performs provider I/O.
