# Tick Input Processor

## What it is

This Processor routes durable scheduler tick envelopes to the tick Action.

## Why it exists

Host clocks must enter the same durable Action lifecycle as every other
application input.

## How to use it

Compose `schedulesPlugin` and send `scheduleTick(...)` from a host clock.

## How it works

It normalizes an optional payload and invokes the tick Action under a stable
operation key.
