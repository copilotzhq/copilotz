# Discord Channel Resource

## What it is

The data-only external-egress policy for a Discord Channel alias.

## Why it exists

Routing policy must be inspectable without exposing provider credentials or
callbacks.

## How to use it

Create it directly or through `createDiscordChannelPlugin()`.

## How it works

It snapshots default Agent aliases and public metadata through the shared
Channel Resource validator.
