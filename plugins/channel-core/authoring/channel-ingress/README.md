# Channel ingress helper

## What it is

Creates credential-safe ingress event envelopes.

## Why it exists

Adapters must pass only durable, sanitized data to the worker.

## How to use it

Call `channelIngress(channelAlias, occurrence, options)`.

## How it works

It clones strict JSON, rejects credential-shaped keys, and derives stable event
identities.
