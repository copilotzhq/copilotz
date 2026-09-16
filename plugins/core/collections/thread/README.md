# Thread Collection

## What it is

The canonical conversation Thread record.

## Why it exists

Conversation membership, status, ancestry, and active revision state need a
durable owner.

## How to use it

Access the `thread` Collection and its membership commands.

## How it works

The schema indexes external and parent IDs and commands update membership and
lifecycle state.
