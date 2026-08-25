# LLM plugin

## What it is

Copilotz’s provider-neutral, durable LLM execution plugin.

## Why it exists

It lets agents select configured models while keeping provider protocols,
credentials, streaming, and recovery behind one Action boundary.

## How to use it

Compose `llmPlugin`, declare Model and optional credential Resources, then
invoke `callLlm` directly or through the Core agent workflow. Pure preflight
estimates are available from `@copilotz/copilotz/llm/tokens`.

## How it works

The plugin contributes `llm.call`; the Action resolves a model, materializes a
built-in or custom Adapter, streams normalized output, and records provider
attempts. Provider-aware estimation is public and side-effect free; learned
calibration remains private process-local execution state.
