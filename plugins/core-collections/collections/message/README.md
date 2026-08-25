# Message Collection

## What it is

The canonical content-bearing Message record.

## Why it exists

Conversation history and revisions require durable, asset-aware records.

## How to use it

Access `message` by ID or query it by Thread and creation order.

## How it works

The Collection adopts declared content, records routing fields, and validates
immutable revision metadata.
