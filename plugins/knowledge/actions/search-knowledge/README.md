# Search Knowledge

## What it is

A provider-configured semantic search action for indexed Knowledge chunks.

## Why it exists

It keeps query embedding and scoped document retrieval behind one model-facing
action.

## How to use it

Configure an embedding resource and use the generated `search_knowledge` tool or
the Action directly.

## How it works

The action embeds the query, applies thread and agent scope, scores indexed
chunks, and returns the best matches.
