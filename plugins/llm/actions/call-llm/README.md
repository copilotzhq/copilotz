# Call LLM

## What it is

The provider-neutral durable `llm.call` Action.

## Why it exists

It separates agent orchestration from individual model-provider protocols.

## How to use it

Compose `llmPlugin` and invoke the `callLlm` Action with configured model
aliases.

## How it works

It resolves model and credential Resources, streams the selected Adapter, and
records normalized output and attempts.

Tool-call stream lanes are speculative drafts. Copilotz validates the final Tool
declaration before accepting it or allowing Core to execute a Tool. A rejected
attempt may publish bounded, credential-safe diagnostic evidence as ordinary
Action progress; adapter authors must never include request content,
credentials, or provider error bodies in that evidence.
