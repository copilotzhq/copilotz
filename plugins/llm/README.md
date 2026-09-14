# LLM plugin

## What it is

Copilotz’s provider-neutral, durable LLM execution plugin.

## Why it exists

It lets agents select configured models while keeping provider protocols,
credentials, streaming, and recovery behind one Action boundary.

## How to use it

Compose `llmPlugin`, declare LLM connection Resources, then invoke `callLlm`
directly or through the Core agent workflow. Pure preflight estimates are
available from `@copilotz/copilotz/llm/tokens`.

## How it works

The plugin contributes `llm.call`; the Action resolves a model, materializes a
built-in or custom Adapter, streams normalized output, and records provider
attempts. Provider-aware estimation is public and side-effect free; learned
calibration remains private process-local execution state.

When an Adapter returns provider-native reasoning state, `llm.call` stores its
opaque JSON blocks as content Assets and stamps the producing adapter, API, and
model. Readable `reasoning` remains ordinary Copilotz transcript content; the
opaque blocks never enter the text protocol. Core replays opaque state only to
the same Agent and only for that exact adapter, API format, and model. The v1
envelope does not encode a connection ID or base URL, so a changed provider
connection must support that same native state. The normal Copilotz text
tool-call protocol is unchanged. Providers without compatible input replay keep
the state out of the next request; DeepSeek ignores native state without native
tools and Groq is output-only.
