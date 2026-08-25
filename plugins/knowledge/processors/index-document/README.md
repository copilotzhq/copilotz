# Index document processor

## What it is

A durable processor that starts indexing when a document is created.

## Why it exists

It decouples the fast ingestion action from asynchronous indexing work.

## How to use it

It is installed automatically by `createKnowledgePlugin`.

## How it works

The processor invokes the index action with the causal operation identity and
treats a settled action error as a completed semantic result.
