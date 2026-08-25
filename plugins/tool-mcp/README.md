# MCP Tools

## What it is

A plugin authoring surface that discovers MCP server Tools and composes them as
native Copilotz Actions and data-only Tool Resources.

## Why it exists

MCP servers describe their capabilities at connection time, so their concrete
Actions and Resources must be generated before application composition.

## How to use it

Call `createMcpToolsPlugin` with MCP server declarations and a connector. For
Deno subprocess servers, import `connectMcp` from `/tools/mcp/stdio`.

## How it works

The generator discovers allowed Tools, validates stable aliases and schemas,
then hands one immutable entry set to the root plugin composer. Each Action
opens a scoped connection, executes one MCP call, and promotes returned media to
canonical content Assets.
