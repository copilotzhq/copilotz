# Provider bridge

## What it is

The shared bridge between a provider wire protocol and the LLM Adapter contract.

## Why it exists

It centralizes content, stream, and attempt translation for built-in providers.

## How to use it

Built-in provider implementations use it internally; application code does not
call it.

## How it works

It serializes requests, consumes provider streams, and returns normalized
Adapter frames and results.
