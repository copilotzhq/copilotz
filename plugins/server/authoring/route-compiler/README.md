# Server Route Compiler

## What it is

A deterministic compiler from the composed plugin registry and one Server Facade
Resource to immutable HTTP routes and OpenAPI 3.2.

## Why it exists

Runtime handling and documentation must use one route authority rather than
maintaining parallel endpoint registries.

## How to use it

Call `compileServerRoutes(registry, facade)` once at Gateway construction. The
Server Fetch boundary uses its matcher and publishes its OpenAPI document.

## How it works

It applies canonical naming, glob exposure, operation filtering, and explicit
overrides, then rejects collisions and unknown override targets.
