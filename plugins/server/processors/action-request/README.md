# Action Request Processor

## What it is

The durable Processor that converts a trusted Server Action request Event into
the internal invocation bridge Action.

## Why it exists

It lets an HTTP request enter through the ordinary application Event boundary
and participate in causal settlement and observation.

## How to use it

Compose `createServerPlugin`; the Fetch facade emits its request Event.

## How it works

It exact-validates the versioned payload and invokes the bridge under a stable
operation key inherited by the complete request scope.
