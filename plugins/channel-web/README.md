# Web Channel

## What it is

An in-process request/observation Channel provider for web applications.

## Why it exists

Web hosts need a small transport-neutral bridge from typed request bodies into
durable Channel ingress.

## How to use it

Compose `createWebChannelPlugin()` and send request bodies through the Channel
server boundary.

## How it works

The data-only Resource declares request-observation egress, while the Adapter
normalizes participants, routing, visibility, and inline media.
