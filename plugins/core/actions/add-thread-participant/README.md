# Add Thread Participant Action

## What it is

Adds one resolved or newly created Participant to a Core Thread.

## Why it exists

Participant creation and membership need one transactional boundary.

## How to use it

Invoke `addThreadParticipant` with a Thread ID and Participant input.

## How it works

It resolves the Participant, creates it if needed, and applies the Thread
membership command in one transaction.
