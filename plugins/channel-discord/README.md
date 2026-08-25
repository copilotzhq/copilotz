# Discord Channel

## What it is

A Discord interactions and Bot API Channel provider.

## Why it exists

Discord authentication, interaction parsing, media handling, and delivery need a
provider-specific boundary around generic Channel semantics.

## How to use it

Compose `createDiscordChannelPlugin({ config })` and expose the Channel server
route to Discord interactions.

## How it works

The Resource declares external egress policy. The Adapter verifies signed
interactions, normalizes messages and attachments, and delivers content through
the Discord Bot transport.
