# Telegram Channel Resource

## What it is

The data-only external-egress policy for a Telegram Channel alias.

## Why it exists

Routing policy must be inspectable without exposing provider credentials.

## How to use it

Create it directly or through `createTelegramChannelPlugin()`.

## How it works

It snapshots default Agent aliases and metadata through the shared Channel
Resource validator.
