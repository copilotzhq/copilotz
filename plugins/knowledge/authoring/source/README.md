# Knowledge source authoring

## What it is

Portable default source loading and text extraction helpers.

## Why it exists

They make URL and common document ingestion work without binding Knowledge to a
filesystem or provider.

## How to use it

Use the defaults implicitly through `createKnowledgePlugin`, or provide them
explicitly as plugin options.

## How it works

The loader fetches bounded HTTP sources and the extractor normalizes text, HTML,
Markdown, and supported document formats.
