# WhatsApp Channel Resource

## What it is

The data-only external-egress policy for a WhatsApp Channel alias.

## Why it exists

Routing policy must be inspectable without exposing provider credentials.

## How to use it

Create it directly or through `createWhatsAppChannelPlugin()`.

## How it works

It snapshots default Agent aliases and metadata through the shared Channel
Resource validator.
