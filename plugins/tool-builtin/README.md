# Built-in Tools

## What it is

This plugin provides the portable tools supplied with every Copilotz runtime.

## Why it exists

Applications need common time, asset, memory, and thread operations without a
host-specific adapter.

## How to use it

Compose `createBuiltInToolsPlugin()` and optionally restrict `include` to the
tool aliases an application exposes.

## How it works

Each tool is composed from a durable Action and a separate, data-only Tool
Resource for LLM presentation.
