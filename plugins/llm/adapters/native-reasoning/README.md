<!-- Provider-native reasoning is opaque continuation state, not Copilotz text. -->

# Native reasoning adapter helpers

## What it is

Small provider-adapter helpers for opaque continuation state such as encrypted
reasoning, thinking signatures, and signed response parts.

## Why it exists

Copilotz keeps its text tool protocol independent from each provider’s native
reasoning continuation format. These helpers retain provider state without
materializing it as Copilotz text.

## How to use it

An adapter passes a matching assistant message to `matchingNativeBlocks` before
forming a provider request, and assigns a terminal-only extractor to its
`ProviderAPI` definition. The helper clones blocks so a provider cannot mutate
durable request state.

## How it works

Adapters retain native reasoning only after the provider has reported a
successful terminal event. The shared stream layer calls each extractor for
every parsed event, including the post-local-stop drain, and replaces its stored
snapshot only when an extractor returns one.

`matchingNativeBlocks` accepts an assistant message only when its schema,
adapter, API identifier, and exact model all match the active provider call.

`createAnthropicNativeReasoningExtractor` handles both Anthropic Messages and
MiniMax's Anthropic-compatible Messages stream: it rebuilds complete thinking
and redacted-thinking blocks from start/delta/stop events and returns them only
after a normal `message_stop` following `end_turn` or `stop_sequence`.
