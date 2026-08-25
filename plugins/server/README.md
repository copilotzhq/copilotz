# Server Plugin

## What it is

The semantic Copilotz HTTP facade over composed Actions, Collections, Channels,
Assets, and safe Agent projections.

## Why it exists

Applications should not rebuild primitive discovery, validation, durable Action
dispatch, streaming, and OpenAPI generation for every HTTP server.

## How to use it

Compose `createServerPlugin(...)`. A Gateway then mounts the configured facade
alongside its internal compatibility surface; Oxian or another Fetch host
carries the returned application handler.

## How it works

The plugin contributes an immutable facade Resource and a durable Event-to-
Action bridge. The package Server boundary compiles routes from the complete
composition and handles Fetch/OpenAPI/multipart transport semantics.
