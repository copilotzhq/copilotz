# Delete Knowledge document

## What it is

An action that deletes a Knowledge document and its indexed chunks.

## Why it exists

It provides one atomic cleanup boundary for model-facing document deletion.

## How to use it

Use the generated `delete_document` tool with either a document ID or source
URI.

## How it works

The action resolves the scoped document, deletes all derived chunks, then
deletes the document in one transaction.
