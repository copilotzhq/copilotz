# Core

## What it is

The semantic plugin for agent Messages, LLM routing, Tools, parallel plans, and
Agent-to-Agent Ask.

## Why it exists

Applications need one durable orchestration layer over provider-neutral LLM and
domain storage primitives.

## How to use it

Install `corePlugin`, compose Agent and Model Resources, then send typed
`message(...)` inputs.

## How it works

Core combines Core Collections with LLM lifecycle processing, projects provider
results into canonical Messages, and coordinates Tool/Ask futures through
durable plans.
