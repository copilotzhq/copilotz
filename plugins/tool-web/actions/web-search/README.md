# Web Search Action

## What it is

A structured DuckDuckGo HTML search Action.

## Why it exists

Agents need discovery results before choosing which pages to fetch.

## How to use it

Grant the matching `web_search` Tool after composing the Web Tools plugin.

## How it works

It rotates coherent browser header profiles, retries transient blocks, parses
bounded result cards, and preserves caller cancellation.
