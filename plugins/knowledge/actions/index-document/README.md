# Index Knowledge document

## What it is

A durable action that indexes one pending Knowledge document.

## Why it exists

It separates ingestion acceptance from the slower loading, extraction, chunking,
and embedding workflow.

## How to use it

Compose it through `createKnowledgePlugin`, or create it with the embedding,
chunking, loader, and extractor options.

## How it works

The action loads the document, extracts and chunks text, requests embeddings,
and atomically writes chunks and the settled document state.
