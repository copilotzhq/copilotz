# MCP Tool Generator

## What it is

The authoring helper that discovers an MCP server's Tool descriptors and
generates native Actions and Tool Resources.

## Why it exists

Generated MCP operations have no stable source directory of their own, but still
need ordinary Copilotz lifecycle, validation, and content behavior.

## How to use it

Pass server declarations and a `connect` implementation to
`createMcpToolsPlugin` before creating the application.

## How it works

Discovery runs before composition. Generated aliases and Action IDs are checked
for collisions, server allowlists are applied, and media payloads are replaced
with materialized ContentRefs before Action completion.
