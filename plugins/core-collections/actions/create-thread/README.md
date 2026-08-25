# Create Thread Action

## What it is

Creates one Core Thread and its initial Participants.

## Why it exists

Thread bootstrap must be atomic and idempotent.

## How to use it

Invoke `createThread` with Thread fields and optional Participant inputs.

## How it works

It resolves existing Participants, creates missing ones in a transaction, and
creates the Thread with their IDs.
