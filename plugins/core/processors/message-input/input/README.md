# Message Input Authoring

## What it is

A typed helper for constructing Core Message ingress envelopes.

## Why it exists

Binary media and correlation fields need a portable, JSON-safe application input
shape.

## How to use it

Call `message({ thread, participant, content, ... })` and pass the result to
`application.send(...)`. A string `thread` identifies an existing Thread. Use an
object such as `{ externalId: "hello" }` to create or reuse a Thread on first
use; an explicit object `id` is preserved as the new record ID.

For example, `recipientIds: ["assistant"]` resolves a configured Agent alias,
creates its canonical Participant record when needed, and enrolls it with the
sender in the Thread.

## How it works

The helper converts inline media bytes to base64 and returns a typed, JSON-safe
input envelope. The Core Processor interprets the envelope; the helper does not
perform storage or channel-specific work.
