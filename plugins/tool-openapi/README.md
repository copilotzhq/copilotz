# OpenAPI Tool Plugin

## What it is

A concrete plugin factory that turns an OpenAPI declaration into executable
Actions and immutable Tool Resources.

## Why it exists

It lets applications expose documented HTTP operations to agents without
hand-writing a separate action and resource for every endpoint.

## How to use it

Declare an integration with `defineApi(...)`, then compose
`createOpenApiToolsPlugin({ apis })` into the application.

## How it works

The authoring generator discovers operations, creates their Action and Tool
Resource pairs, and passes that generated set to this root composition module.
