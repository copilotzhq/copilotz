# Web Tools

## What it is

A selectable plugin of runtime-neutral HTTP, text-fetching, and web-search
Tools.

## Why it exists

Agents often need bounded network access without receiving filesystem or
subprocess capabilities.

## How to use it

Compose `createWebToolsPlugin()` and optionally select Tool aliases with its
`include` option.

## How it works

The plugin registers three durable Actions and matching data-only Tool
Resources. Each Action enforces request, response, timeout, and cancellation
bounds.
