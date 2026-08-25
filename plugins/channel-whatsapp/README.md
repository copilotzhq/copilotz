# WhatsApp Channel

## What it is

A WhatsApp Cloud API Channel provider.

## Why it exists

WhatsApp webhook verification, media, interactive messages, and delivery need a
provider-specific boundary around generic Channel semantics.

## How to use it

Compose `createWhatsAppChannelPlugin({ config })` and route Meta webhooks to the
Channel server.

## How it works

The Resource declares external egress policy. The Adapter verifies and
normalizes events, then delivers content through the Graph API transport.
