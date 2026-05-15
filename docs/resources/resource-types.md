---
title: Resource Types
description: All resource families supported by Copilotz and what each one is for.
section: Resources
order: 10
status: stable
---

# Resource Types

Resources are the parts Copilotz composes into an app.

| Resource    | Purpose                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| agents      | Model-backed workers that respond, reason, and call tools               |
| tools       | Agent-owned executable actions                                          |
| APIs        | External HTTP APIs that can be exposed as tools                         |
| MCP servers | External Model Context Protocol servers                                 |
| processors  | Event pipeline handlers                                                 |
| memory      | Context contributors such as history, participant, and retrieval memory |
| skills      | Instruction bundles with progressive disclosure                         |
| features    | App-facing backend actions                                              |
| channels    | Transport ingress and egress adapters                                   |
| llm         | LLM provider factories                                                  |
| embeddings  | Embedding provider factories                                            |
| storage     | Asset storage adapters                                                  |
| collections | Typed application data models                                           |

## Directory Shape

```txt
resources/
  agents/
  tools/
  features/
  collections/
  channels/
  processors/
  memory/
  skills/
  llm/
  embeddings/
  storage/
```

## Related Pages

- [Resources](../core-concepts/resources.md)
- [Resource Loading](../runtime/resource-loading.md)
- [Resource Manifest](../reference/resource-manifest.md)
