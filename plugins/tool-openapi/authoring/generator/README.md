# OpenAPI Generator

## What it is

The authoring generator that converts OpenAPI operations into Copilotz Actions
and Tool Resources.

## Why it exists

OpenAPI operations are created dynamically from a schema, so they have one
implementation owner instead of a directory for every generated endpoint.

## How to use it

Use `defineApi` to declare an API and `createOpenApiToolsPlugin` to generate the
corresponding plugin at composition time.

## How it works

The generator normalizes the schema, builds request executors and data-only Tool
Resources, then delegates their composition to the plugin root.
