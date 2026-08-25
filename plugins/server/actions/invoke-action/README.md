# Invoke Action

## What it is

The durable internal bridge between one compiled HTTP Action route and the
application Action it targets.

## Why it exists

Public application ingress is Event-based, while executable Actions are called
inside runtime contexts. The bridge preserves the ordinary Action lifecycle.

## How to use it

Applications do not call it directly. The Server request Processor invokes it
with the target fixed by the compiled route table.

## How it works

It invokes the composed Action caller, records a bounded completion or failure
envelope, and attaches trusted Server provenance to the target lifecycle.
