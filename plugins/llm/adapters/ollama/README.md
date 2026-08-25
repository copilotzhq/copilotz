# Ollama adapter

## What it is

The built-in Ollama provider wire adapter.

## Why it exists

It lets local Ollama models participate through the same LLM boundary.

## How to use it

Declare a Model Resource with `provider: "ollama"` and, when needed, `baseUrl`.

## How it works

It constructs Ollama chat requests and converts terminal frames and usage.
