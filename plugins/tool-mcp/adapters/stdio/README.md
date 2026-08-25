# MCP Stdio Adapter

## What it is

A Deno-hosted connector for MCP servers reached through the official SDK's stdio
transport.

## Why it exists

Portable MCP generation should not own subprocess creation or host transport
details.

## How to use it

Import `connectMcp` from `/tools/mcp/stdio` and pass it as the generator's
`connect` option.

## How it works

The Adapter validates the server command, starts the SDK transport, forwards
Tool discovery and invocation, propagates cancellation, and closes the
connection after each operation.
