# Telegram Channel Adapter

## What it is

The process-local Telegram webhook and delivery Adapter.

## Why it exists

Telegram credentials and transport callbacks must stay outside data-only
Resources.

## How to use it

Provide static or dynamically resolved Telegram config through the plugin.

## How it works

It verifies webhook secrets, downloads media, normalizes messages and callbacks,
and emits Bot-native text, media, and button payloads.
