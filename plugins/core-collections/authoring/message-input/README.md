# Message Input Authoring

## What it is

A typed helper for constructing Core Message ingress envelopes.

## Why it exists

Binary media and correlation fields need a portable, JSON-safe application input
shape.

## How to use it

Call `message({ thread, participant, content, ... })` and pass the result to the
application.

## How it works

The helper converts inline media bytes to base64 envelopes and freezes the
opaque input payload.
