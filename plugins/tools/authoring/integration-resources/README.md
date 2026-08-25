# Tool Integration Declarations

## What it is

Typed API and MCP server declarations consumed by the OpenAPI and MCP Tool
generators.

## Why it exists

Generators need immutable semantic configuration, including explicitly typed
request policies and host transport declarations.

## How to use it

Construct an `API` or `MCPServer` value and pass it to the matching generator.

## How it works

These process-local declarations are interpreted during authoring; generated
runtime Actions and Tool Resources are owned by their concrete plugins.
