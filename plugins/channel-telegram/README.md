# Telegram Channel

## What it is

A Telegram Bot API Channel provider.

## Why it exists

Telegram webhook authentication, update parsing, media, and delivery need a
provider-specific boundary around generic Channel semantics.

## How to use it

Compose `createTelegramChannelPlugin({ config })` and route Telegram webhooks to
the Channel server.

## How it works

The Resource declares external egress policy. The Adapter authenticates and
normalizes updates, then delivers content through the Telegram transport.
