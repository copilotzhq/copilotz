# Fail Ask Processor

## What it is

Settles an Ask branch when the asked Agent's LLM call fails or is cancelled.

## Why it exists

Parent plans must fan in even when a delegated Agent cannot answer.

## How to use it

It is installed by Core and matches failed/cancelled `llm.call` events carrying
Ask metadata.

## How it works

It validates Ask ownership, creates a bounded failure, and resumes the same
durable branch.
