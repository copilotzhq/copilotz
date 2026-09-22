# Channel submission helper

## What it is

Submits accepted Channel occurrences through an application's `send` capability.

## Why it exists

HTTP and other trusted transports share the same strict durable envelope,
ordering, idempotency, and partial-failure behavior.

## How to use it

Call `submitChannel(application, channelId, occurrences, options)` with
occurrences that an adapter has already accepted. The helper validates every
occurrence before sending the first one.

## How it works

It delegates strict JSON and credential checks to `channelIngress`, clones
trusted operation metadata for each envelope, and cancels earlier handles when a
later send fails.
