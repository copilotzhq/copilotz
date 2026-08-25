# Channel egress action

## What it is

Builds provider-neutral delivery intents for an agent message.

## Why it exists

The retryable network delivery must reuse a stable, durable intent.

## How to use it

The egress processor invokes it after an externally bound agent message is
created.

## How it works

It finds applicable bindings and returns one stable intent per external channel.
