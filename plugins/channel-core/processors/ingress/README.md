# Channel ingress processor

## What it is

Consumes durable accepted channel occurrences.

## Why it exists

It isolates provider-event delivery from graph mutation execution.

## How to use it

Compose `channelsPlugin` and emit `channelIngress` envelopes.

## How it works

It invokes the ingress action under a stable operation identity.
