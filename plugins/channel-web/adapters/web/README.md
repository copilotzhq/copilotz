# Web Channel Adapter

## What it is

The process-local Adapter for Web Channel requests.

## Why it exists

Transport parsing should remain separate from durable Channel Resources.

## How to use it

It is composed automatically by `createWebChannelPlugin()`.

## How it works

It accepts typed occurrences, normalizes participants and visibility, and
promotes base64 or data-URL media into byte-bearing content inputs.
