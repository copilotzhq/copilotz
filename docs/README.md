# Copilotz Documentation

Copilotz combines a generic event runtime with an agent harness composed from
plugins. It supports agents embedded in existing products and shared
conversations between people and agents. These guides describe the current
public surface; the authoritative list of entrypoints is the `exports` in
`../deno.json`.

## Start

1. [Getting started](getting-started/README.md): build one Notes assistant into
   shared application behavior, with one new concept per chapter and commented
   examples. Complete the six foundation chapters, then choose optional
   branches.
2. [Understanding Copilotz](overview.md): what you can build, how the runtime
   and harness fit together, and choosing an integration path.
3. [Quickstart](quickstart.md): find the next step if you already know what you
   want to build.

## Build

- [Agent capabilities](agent-capabilities.md): tools, teammates and skills,
  granted per agent.
- [Agents asking agents](multi-agent-ask.md): the public `ask`.
- [HTTP server and browser client](server.md): sign-in, access, shared rooms and
  live observation.
- [Channels](channels.md): web, WhatsApp, Telegram, Discord and Zendesk.
- [Shared Spaces](spaces.md): work contexts with members and resources.
- [Semantic memory](memory.md) and [skills](skills.md).
- [Goal Action](goals.md): multi-turn evaluation over ordinary sends.

## Run in production

- [Events, deliveries, and recovery](events-deliveries-recovery.md): durable
  facts, retries, and what "at least once" means for your code.
- [Embedding, Gateways, and Workers](embedding-and-hypervisors.md): one process
  or many, and sizing the database pool.
- [Host capability adapters](runtime-adapters.md).

## Understand and extend

- [Architecture](architecture.md), and the first-principles contract in
  [`ARCHITECTURE.md`](../ARCHITECTURE.md).
- [Plugins and processors](plugins-and-processors.md): add your own behavior.
- [Plugin source layout](plugin-layout.md) and
  [convention-first authoring](convention-authoring.md).
- [Content and assets](content-assets.md) and [progressive streams](streams.md).
- [API and package reference](api.md).
