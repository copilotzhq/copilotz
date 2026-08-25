# LLM credentials

## What it is

A process-local credential Resource for a built-in provider.

## Why it exists

It enables service keys and tenant-scoped resolvers without placing secrets in
Action inputs or event data.

## How to use it

Use `defineLlmCredential(...)` in `resources.llmCredentials`, then refer to it
from a Model by alias.

## How it works

The helper validates and freezes static or resolver-based credentials; the
Action resolves it immediately before an attempt.
