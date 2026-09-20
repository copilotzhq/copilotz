# Anthropic adapter

## What it is

The built-in Anthropic provider wire adapter.

## Why it exists

It translates Anthropic’s Messages protocol into the LLM boundary.

## How to use it

Declare a LLM connection with `provider: "anthropic"`.

## How it works

It builds Anthropic requests and decodes streaming content and usage frames.

Claude Opus 5 uses the fixed `claude-opus-5` identifier (no dated aliases). The
adapter uses adaptive thinking, preserves the provider's default effort when
none is supplied, and omits unsupported sampling parameters. Thinking defaults
on; this is distinct from models that require it unconditionally. Copilotz's
provider-neutral `minimal` effort maps to `low`. Signed thinking blocks,
including empty display text, are preserved for subsequent turns.

See Anthropic's
[Opus 5 migration guide](https://platform.claude.com/docs/en/models/opus-5/migration-guide).
