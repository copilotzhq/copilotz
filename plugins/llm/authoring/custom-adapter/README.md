# Custom LLM adapter

## What it is

A narrow authoring helper for application-defined model provider adapters.

## Why it exists

It gives custom providers the same validated Adapter boundary used by built-in
providers.

## How to use it

Wrap an object with `call(input)` in `createLlmAdapter(...)`, then reference its
alias from a custom Model Resource.

## How it works

The helper accepts only the executable `call` boundary and freezes it; transport
details remain application-owned.
