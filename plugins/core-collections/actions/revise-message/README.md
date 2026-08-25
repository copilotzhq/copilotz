# Revise Message Action

## What it is

Creates a new immutable revision of a human-authored Core Message.

## Why it exists

Editing must preserve history while advancing the Thread's active Message
branch.

## How to use it

Invoke `reviseMessage` with a new ID, Thread ID, prior Message ID, and
replacement content.

## How it works

It validates ownership, prepares replacement content, creates the revision, and
updates the active branch transactionally.
