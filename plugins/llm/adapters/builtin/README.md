# Built-in adapters

## What it is

The adapter factory for the first-party LLM provider protocols.

## Why it exists

It keeps provider selection private to built-in Model Resources.

## How to use it

Configure a built-in Model Resource; `llm.call` materializes this adapter
automatically.

## How it works

It validates provider mode and selects the matching protocol implementation.
