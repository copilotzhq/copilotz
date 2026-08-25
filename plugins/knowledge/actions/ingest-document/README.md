# Ingest Knowledge document

## What it is

An action that accepts one source for Knowledge indexing.

## Why it exists

It gives callers a fast, validated acknowledgement while durable indexing
proceeds asynchronously.

## How to use it

Use the `ingest_document` tool created by the Knowledge plugin, or invoke its
Action directly.

## How it works

The action validates the source, prepares content when needed, and creates one
pending document record.
