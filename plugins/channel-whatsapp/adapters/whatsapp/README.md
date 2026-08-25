# WhatsApp Channel Adapter

## What it is

The process-local WhatsApp webhook and delivery Adapter.

## Why it exists

Meta credentials and transport callbacks must stay outside data-only Resources.

## How to use it

Provide static or dynamically resolved WhatsApp config through the plugin.

## How it works

It verifies webhook handshakes and signatures, stages media, normalizes inbound
messages, and emits Graph-native content and interactive payloads.
