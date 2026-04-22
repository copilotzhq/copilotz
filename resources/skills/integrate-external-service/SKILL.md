---
name: integrate-external-service
description: Choose the right Copilotz integration pattern for third-party services and implement it cleanly.
allowed-tools: [
  read_file,
  write_file,
  search_files,
  http_request,
  persistent_terminal,
]
tags: [execution, integration, external-service]
---

# Integrate External Service

Use this skill when a project needs to connect to an outside system such as
GitHub, Stripe, Notion, Slack, or an internal API.

## Goal

Pick the right Copilotz integration boundary before writing code.

## Decision Guide

- Use `add-api-integration` when the service has a stable OpenAPI spec and you
  want generated tools.
- Use `configure-mcp` when the service is best exposed through MCP.
- Use `create-tool` for a narrow agent-callable integration with custom logic.
- Use `create-feature` when your app or frontend should call the service
  directly.
- Use `create-channel` when the service is really a transport boundary.

## Workflow

1. Identify the caller:
   - user-facing app
   - agent
   - runtime/background flow
2. Identify the service interface:
   - OpenAPI
   - MCP
   - custom HTTP SDK
   - webhook/transport
3. Choose the lightest pattern that preserves clarity.
4. Keep secrets and auth resolution out of persisted resource files when
   possible.
5. Add the smallest useful verification path:
   - example request
   - tool invocation
   - integration test

## Common Mistakes

- Defaulting to a custom tool when an API integration or MCP server is a better
  fit
- Exposing app backend contracts as agent tools
- Mixing auth resolution, transport handling, and business logic into one file

## Related Skills

- Pair with `implement-feature` if the integration is part of a larger
  user-facing feature.
- Pair with `debug-runtime-issue` if the integration exists but is failing.
