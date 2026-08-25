# LLM token estimation

## What it is

A dependency-free, provider-aware estimator for text and multimodal LLM input.

## Why it exists

Applications need bounded prompt, chunking, and memory policies before a
provider reports actual usage. These estimates belong to LLM semantics rather
than the generic runtime.

## How to use it

Import `estimateTextTokens` or `estimateTokens` from
`@copilotz/copilotz/llm/tokens`. Supply media dimensions or durations rather
than raw media payloads.

## How it works

Text estimation samples bounded Unicode input. Multimodal estimation applies
provider/model profiles and returns a confidence-ranked breakdown with an
optional safety margin. It performs no provider I/O.
