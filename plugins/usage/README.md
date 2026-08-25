# Usage plugin

## What it is

The Usage plugin projects metered LLM and Tool work into a durable accounting
ledger.

## Why it exists

Applications need consistent usage analytics without coupling the generic
runtime to semantic LLM or Tool events.

## How to use it

Import `createUsageWorkflowPlugin` from `@copilotz/copilotz/usage` and compose
the returned plugin. Cost and record policies remain optional callbacks.

## How it works

The plugin composes one Usage Collection and two lifecycle Processors. The
Processors normalize attribution and persist idempotent per-operation rows.
