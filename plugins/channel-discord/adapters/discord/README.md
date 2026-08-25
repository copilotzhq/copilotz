# Discord Channel Adapter

## What it is

The process-local Discord interactions and delivery Adapter.

## Why it exists

Discord transport behavior and credentials must remain outside durable Channel
Resources.

## How to use it

Provide static or dynamically resolved Discord config through the plugin
factory.

## How it works

It verifies Ed25519 signatures, parses commands and attachments, normalizes
Channel inputs, and sends text, media, or button payloads through the transport.
