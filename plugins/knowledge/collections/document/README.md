# Knowledge document collection

## What it is

The canonical state record for one ingested Knowledge document.

## Why it exists

It records source provenance and the durable lifecycle of indexing.

## How to use it

Compose the Knowledge plugin and use the `document` Collection through the
application context.

## How it works

Commands transition a pending document through processing, indexed, duplicate,
or failed states and link derived chunks.
