# Channel ingress action

## What it is

Creates Core graph records from one accepted provider occurrence.

## Why it exists

Provider input needs one durable, replay-safe path into a conversation.

## How to use it

Use `channelIngress` to emit its input event; the ingress processor invokes this
action.

## How it works

It validates provider data, prepares content, and commits participants, thread,
binding, and message atomically.
