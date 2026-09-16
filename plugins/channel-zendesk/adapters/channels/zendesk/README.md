# Zendesk Channel Adapter

## What it is

The process-local Zendesk webhook and delivery Adapter.

## Why it exists

Zendesk credentials and transport callbacks must stay outside data-only
Resources.

## How to use it

Provide static or dynamically resolved Zendesk config through the plugin.

## How it works

It verifies webhook secrets, downloads media, normalizes conversation events,
and emits provider-native content and action payloads.
