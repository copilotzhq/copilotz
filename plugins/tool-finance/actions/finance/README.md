# Finance Action

## What it is

The executable Action behind the Finance Tool.

## Why it exists

It isolates provider selection, validation, cancellation, and JSON-safe output
from the Tool presentation.

## How to use it

Compose it through `createFinanceToolsPlugin`, or call `createFinanceAction`
when an application needs the Action independently.

## How it works

The Action selects a Finance provider, validates the requested operation, and
returns a lossless JSON clone of the provider result.
