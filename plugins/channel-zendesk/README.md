# Zendesk Channel

## What it is

A Zendesk Conversations Channel provider.

## Why it exists

Zendesk webhook authentication, conversation events, media, and delivery need a
provider-specific boundary around generic Channel semantics.

## How to use it

Compose `createZendeskChannelPlugin({ config })` and route Zendesk webhooks to
the Channel server.

## How it works

The Resource declares external egress policy. The Adapter authenticates and
normalizes events, then delivers content through the Zendesk transport.
